const express = require('express');
const sirinium = require('sirinium');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const utils = require('./utils');
const calendar = require('./calendar');
const Teacher = require('./teacher');
const { setGlobalDispatcher, ProxyAgent, Agent } = require('undici');

// Глобальная настройка undici: форсируем IPv4 и поддерживаем HTTP(S)_PROXY
try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy || process.env.https_proxy;
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } else {
        setGlobalDispatcher(new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000, connect: { family: 4, hints: 0 } }));
    }
} catch (_) {}

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'front')));

// Директория для кэша
const CACHE_DIR = path.join(__dirname, 'cache');
// Путь к файлу кэша
const CACHE_FILE = path.join(CACHE_DIR, 'schedule_cache.json');
const TEACHERS_CACHE_FILE = path.join(CACHE_DIR, 'teachers_cache.json');
// Интервал обновления кэша (20 минут)
const CACHE_UPDATE_INTERVAL = 20 * 60 * 1000;
// Дополнительная задержка при неудачном обновлении (40 минут)
const FAILURE_BACKOFF_MS = parseInt(process.env.CACHE_FAILURE_BACKOFF_MS || '2400000', 10);
// Директория для файлового кэша по группам
const GROUP_CACHE_DIR = path.join(CACHE_DIR, 'groups');


// Объект для хранения кэша в памяти
let scheduleCache = {};

// Время последнего обновления кэша
let lastCacheUpdate = 0;

// Безопасное имя файла на основе идентификатора группы
function sanitizeFileName(name) {
    return String(name).replace(/[^a-zA-Z0-9\u0400-\u04FF._-]/g, '_');
}

// Функция для получения расписания из API
async function fetchScheduleFromAPI(group, week) {
    const client = new sirinium.Client();
    await client.getInitialData();
    await client.changeWeek(Number(week));
    return await client.getGroupSchedule(group);
}


let GROUPS = [];
let TEACHERS = [];

// Загружаем группы и преподавателей из файлов
async function loadGroupsAndTeachers() {
    try {
        const groupsData = await fs.readFile(path.join(__dirname, 'static', 'groups.json'), 'utf8');
        GROUPS = JSON.parse(groupsData);
    } catch (e) {
        console.error('Не удалось загрузить группы:', e);
        GROUPS = [];
    }
    try {
        const teachersData = await fs.readFile(path.join(__dirname, 'static', 'teachers.json'), 'utf8');
        TEACHERS = JSON.parse(teachersData);
    } catch (e) {
        console.error('Не удалось загрузить преподавателей:', e);
        TEACHERS = [];
    }
}

// Функция для обновления кэша (обе недели)
async function updateCache() {
    try {
        console.log('Обновление кэша расписания...');
        const newCache = {};

        let client;
        try {
            client = new sirinium.Client();
            await client.getInitialData();
        } catch (e) {
            console.error('Не удалось инициализировать клиент для групп:', e);
            return false;
        }

        const delayMs = parseInt(process.env.BATCH_DELAY_MS || '120000', 10);
        let failed = false;

        // Получаем текущую неделю для всех групп
        await client.changeWeek(0);
        for (const group of GROUPS) {
            try {
                newCache[group] = { week0: await client.getGroupSchedule(group), week1: [] };
            } catch (error) {
                const cause = error && error.cause ? error.cause : {};
                console.error(`Ошибка при получении расписания для группы ${group} (week0):`, {
                    name: error?.name, message: error?.message, code: cause?.code
                });
                failed = true;
                break;
            }
            if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        }

        if (failed) {
            console.warn('Обновление кэша прервано (week0).');
            return false;
        }

        // Получаем следующую неделю для всех групп
        await client.changeWeek(1);
        for (const group of GROUPS) {
            try {
                newCache[group].week1 = await client.getGroupSchedule(group);
            } catch (error) {
                const cause = error && error.cause ? error.cause : {};
                console.error(`Ошибка при получении расписания для группы ${group} (week1):`, {
                    name: error?.name, message: error?.message, code: cause?.code
                });
                failed = true;
                break;
            }
            if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        }

        if (failed) {
            console.warn('Обновление кэша прервано (week1).');
            return false;
        }

        try { await fs.mkdir(GROUP_CACHE_DIR, { recursive: true }); } catch (_) {}

        for (const [group, data] of Object.entries(newCache)) {
            const filePath = path.join(GROUP_CACHE_DIR, `${sanitizeFileName(group)}.json`);
            try {
                await fs.writeFile(filePath, JSON.stringify(data, null, 2));
            } catch (e) {
                console.error('Не удалось записать файл кэша для группы', group, e?.message);
            }
        }

        await fs.writeFile(CACHE_FILE, JSON.stringify(newCache, null, 2));
        scheduleCache = newCache;
        lastCacheUpdate = Date.now();
        console.log('Кэш успешно обновлен');
        return true;
    } catch (error) {
        console.error('Ошибка при обновлении кэша:', error);
        return false;
    }
}

// Функция для получения расписания учителя из API
async function fetchTeacherScheduleFromAPI(teacher, week) {
    const client = new Teacher();
    await client.getInitialData();
    await client.changeWeek(Number(week));
    return await client.getSchedule(teacher);
}

// Функция для обновления кэша учителей (обе недели)
let teachersCache = {};
async function updateTeachersCache() {
    try {
        console.log('Обновление кэша преподавателей...');
        const newCache = {};
        const teacherIds = TEACHERS && typeof TEACHERS === 'object' && !Array.isArray(TEACHERS) ? Object.keys(TEACHERS) : TEACHERS;

        let client;
        try {
            client = new Teacher();
            await client.getInitialData();
        } catch (e) {
            console.error('Не удалось инициализировать клиент для преподавателей:', e);
            return false;
        }

        const delayMs = parseInt(process.env.BATCH_DELAY_MS || '120000', 10);
        let failed = false;

        // Получаем текущую неделю
        await client.changeWeek(0);
        for (const teacherId of teacherIds) {
            try {
                newCache[teacherId] = { week0: await client.getSchedule(teacherId), week1: [] };
            } catch (error) {
                const cause = error && error.cause ? error.cause : {};
                console.error(`Ошибка при получении расписания для преподавателя ${teacherId} (week0):`, {
                    name: error?.name, message: error?.message, code: cause?.code
                });
                failed = true;
                break;
            }
            if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        }

        if (failed) {
            console.warn('Обновление кэша преподавателей прервано (week0).');
            return false;
        }

        // Получаем следующую неделю
        await client.changeWeek(1);
        for (const teacherId of teacherIds) {
            try {
                newCache[teacherId].week1 = await client.getSchedule(teacherId);
            } catch (error) {
                const cause = error && error.cause ? error.cause : {};
                console.error(`Ошибка при получении расписания для преподавателя ${teacherId} (week1):`, {
                    name: error?.name, message: error?.message, code: cause?.code
                });
                failed = true;
                break;
            }
            if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        }

        if (failed) {
            console.warn('Обновление кэша преподавателей прервано (week1).');
            return false;
        }

        await fs.writeFile(TEACHERS_CACHE_FILE, JSON.stringify(newCache, null, 2));
        teachersCache = newCache;
        lastCacheUpdate = Date.now();
        console.log('Кэш преподавателей успешно обновлен');
        return true;
    } catch (error) {
        console.error('Ошибка при обновлении кэша преподавателей:', error);
        return false;
    }
}


// Загружаем кэш при запуске сервера (без вызова updateCache - этим займётся планировщик)
async function loadCache() {
    // Убеждаемся, что директория кэша существует
    try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch (_) {}
    try { await fs.mkdir(GROUP_CACHE_DIR, { recursive: true }); } catch (_) {}
    try {
        const data = await fs.readFile(CACHE_FILE, 'utf8');
        scheduleCache = JSON.parse(data);
        lastCacheUpdate = Date.now();
        console.log('Кэш загружен из файла');
    } catch (error) {
        console.log('Кэш не найден, будет создан планировщиком...');
    }
}

// Загружаем кэш учителей при запуске сервера
async function loadTeachersCache() {
    try {
        const data = await fs.readFile(TEACHERS_CACHE_FILE, 'utf8');
        teachersCache = JSON.parse(data);
        lastCacheUpdate = Date.now();
        console.log('Кэш преподавателей загружен из файла');
    } catch (error) {
        console.log('Кэш преподавателей не найден, будет создан планировщиком...');
    }
}


// Планировщик с бэкоффом: после провала увеличиваем задержку на 5 минут
async function scheduleGroupUpdate() {
    const ok = await updateCache();
    const delay = ok ? CACHE_UPDATE_INTERVAL : (CACHE_UPDATE_INTERVAL + FAILURE_BACKOFF_MS);
    setTimeout(scheduleGroupUpdate, delay);
}

async function scheduleTeacherUpdate() {
    const ok = await updateTeachersCache();
    const delay = ok ? CACHE_UPDATE_INTERVAL : (CACHE_UPDATE_INTERVAL + FAILURE_BACKOFF_MS);
    setTimeout(scheduleTeacherUpdate, delay);
}

app.get('/api/schedule', async (req, res) => {
    try {
        const { group, week = 0 } = req.query;

        // week=0 или week=1 берём из кэша
        if (week == 0 || week == 1) {
            const weekKey = week == 0 ? 'week0' : 'week1';

            // Пробуем файловый кэш
            try {
                const filePath = path.join(GROUP_CACHE_DIR, `${sanitizeFileName(group)}.json`);
                const content = await fs.readFile(filePath, 'utf8');
                const cached = JSON.parse(content);
                if (cached[weekKey]) return res.json(cached[weekKey]);
            } catch (_) {}

            // Пробуем память
            if (scheduleCache[group] && scheduleCache[group][weekKey]) {
                return res.json(scheduleCache[group][weekKey]);
            }

            // Fallback: запрос к API
            const schedule = await fetchScheduleFromAPI(group, week);
            if (!scheduleCache[group]) scheduleCache[group] = { week0: [], week1: [] };
            scheduleCache[group][weekKey] = schedule;
            return res.json(schedule);
        } else {
            // Для других недель получаем данные напрямую из API
            const schedule = await fetchScheduleFromAPI(group, week);
            res.json(schedule);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Эндпоинт для получения списка групп
app.get('/api/groups', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'static', 'groups.json'));
    } catch (error) {
        res.status(500).json({ error: 'Не удалось получить список групп' });
    }
});

// эндпоинт для получения преподавателей
app.get('/api/teachers', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'static', 'teachers.json'));
    } catch (error) {
        res.status(500).json({ error: 'Не удалось получить список преподавателей' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'front', 'index.html'));
});


// эндоинт для расписания учителей
app.get('/api/teacherschedule', async (req, res) => {
    try {
        const { id, week = 0 } = req.query;

        // week=0 или week=1 берём из кэша
        if (week == 0 || week == 1) {
            const weekKey = week == 0 ? 'week0' : 'week1';

            if (teachersCache[id] && teachersCache[id][weekKey]) {
                return res.json(teachersCache[id][weekKey]);
            }

            // Fallback: запрос к API
            const schedule = await fetchTeacherScheduleFromAPI(id, week);
            if (!teachersCache[id]) teachersCache[id] = { week0: [], week1: [] };
            teachersCache[id][weekKey] = schedule;
            return res.json(schedule);
        } else {
            // Для других недель получаем данные напрямую из API
            const schedule = await fetchTeacherScheduleFromAPI(id, week);
            res.json(schedule);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Эндпоинт для получения календаря группы в формате iCalendar (текущая + следующая недели)
app.get('/calendar/group', async (req, res) => {
    try {
        let { group } = req.query;

        if (!group) {
            return res.status(400).json({ error: 'Параметр group обязателен' });
        }

        group = decodeURIComponent(group);

        // Берём обе недели из кэша
        const cached = scheduleCache[group] || null;
        const icsCalendar = await calendar.getGroupCalendar(group, cached);

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="schedule-${encodeURIComponent(group)}.ics"`);
        res.send(icsCalendar);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Эндпоинт для получения календаря преподавателя в формате iCalendar (текущая + следующая недели)
app.get('/calendar/teacher', async (req, res) => {
    try {
        let { id } = req.query;

        if (!id) {
            return res.status(400).json({ error: 'Параметр id обязателен' });
        }

        id = decodeURIComponent(id);

        // Берём обе недели из кэша
        const cached = teachersCache[id] || null;
        const icsCalendar = await calendar.getTeacherCalendar(id, cached);

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="schedule-teacher-${encodeURIComponent(id)}.ics"`);
        res.send(icsCalendar);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// Загружаем группы, преподавателей и стартуем сервер сразу
loadGroupsAndTeachers().then(() => {
    // Стартуем сервер сразу, не дожидаясь загрузки кэша
    app.listen(3000, '0.0.0.0', () => console.log('Server started on port 3000'));

    // Загружаем кэш в фоне
    loadCache().then(() => {
        scheduleGroupUpdate();
    });
    loadTeachersCache().then(() => {
        scheduleTeacherUpdate();
    });
});