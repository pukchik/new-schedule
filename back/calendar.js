const sirinium = require('sirinium');
const Teacher = require('./teacher');

/**
 * Форматирует дату в формат iCalendar (YYYYMMDDTHHMMSS)
 * @param {Date} date - Дата для форматирования
 * @returns {string} - Отформатированная дата
 */
function formatDateForICS(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

/**
 * Объединяет события с одинаковым временем и предметом в одно событие
 * @param {Array} events - Массив событий расписания
 * @returns {Array} - Массив объединенных событий
 */
function mergeEventsByTime(events) {
    const eventMap = new Map();
    
    events.forEach(event => {
        // Создаем уникальный ключ на основе даты, времени и предмета
        const key = `${event.date}-${event.startTime}-${event.endTime}-${event.discipline}-${event.classroom}`;
        
        if (eventMap.has(key)) {
            // Если событие уже есть, добавляем группу к существующему
            const existing = eventMap.get(key);
            if (event.group) {
                if (!existing.groups) {
                    existing.groups = existing.group ? [existing.group] : [];
                }
                if (!existing.groups.includes(event.group)) {
                    existing.groups.push(event.group);
                }
            }
        } else {
            // Создаем новое событие
            const merged = { ...event };
            if (event.group) {
                merged.groups = [event.group];
            }
            eventMap.set(key, merged);
        }
    });
    
    return Array.from(eventMap.values());
}

/**
 * Создает событие iCalendar из данных расписания
 * @param {Object} event - Событие расписания
 * @param {boolean} isTeacher - Флаг, указывающий что это расписание преподавателя
 * @returns {string} - Событие в формате iCalendar
 */
function createICSEvent(event, isTeacher = false) {
    const [day, month, year] = event.date.split('.');
    const [startHour, startMinute] = event.startTime.split(':');
    const [endHour, endMinute] = event.endTime.split(':');
    
    const dtstart = new Date(year, month - 1, day, startHour, startMinute);
    const dtend = new Date(year, month - 1, day, endHour, endMinute);
    const dtstamp = new Date();
    
    // Экранируем специальные символы для iCalendar
    const escapeICS = (str) => {
        return String(str || '')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    };

    const summary = escapeICS(event.discipline || 'Занятие');
    
    const classroom = event.classroom ? event.classroom.replace(/_/g, ' ') : '';
    const location = escapeICS(classroom);
    
    const descriptionParts = [];
    
    // Для преподавателей показываем группу, для групп — преподавателя
    if (isTeacher) {
        // Используем объединенные группы если есть, иначе одну группу
        if (event.groups && event.groups.length > 0) {
            const groupNames = event.groups.join(', ');
            descriptionParts.push(groupNames);
        } else if (event.group) {
            descriptionParts.push(event.group);
        }
    } else {
        if (event.teachers) {
            const teacherNames = Object.values(event.teachers)
                .map(t => t.fio)
                .join(', ');
            if (teacherNames) descriptionParts.push(teacherNames);
        }
    }
    
    if (event.comment) descriptionParts.push(`Комментарий: ${event.comment}`);
    const description = escapeICS(descriptionParts.join('\\n'));
    
    const uid = `${event.date}-${event.startTime}-${event.classroom || 'none'}-${event.group || 'schedule'}@schedule`;

    return [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${formatDateForICS(dtstamp)}`,
        `DTSTART:${formatDateForICS(dtstart)}`,
        `DTEND:${formatDateForICS(dtend)}`,
        `SUMMARY:${summary}`,
        location ? `LOCATION:${location}` : '',
        description ? `DESCRIPTION:${description}` : '',
        'STATUS:CONFIRMED',
        'END:VEVENT'
    ].filter(line => line).join('\r\n');
}

/**
 * Создает календарь в формате iCalendar из массива событий
 * @param {Array} events - Массив событий расписания
 * @param {string} calendarName - Название календаря
 * @param {boolean} isTeacher - Флаг, указывающий что это расписание преподавателя
 * @returns {string} - Календарь в формате iCalendar
 */
function createICSCalendar(events, calendarName = 'Расписание', isTeacher = false) {
    const icsEvents = events.map(event => createICSEvent(event, isTeacher)).join('\r\n');
    
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Schedule Calendar//RU',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${calendarName}`,
        'X-WR-TIMEZONE:Europe/Moscow',
        icsEvents,
        'END:VCALENDAR'
    ].join('\r\n');
}

/**
 * Получает расписание группы на текущую и следующую недели в одном календаре
 * @param {string} group - Название/ID группы
 * @param {Object|null} cached - Кэшированные данные { week0: [...], week1: [...] }
 * @returns {Promise<string>} - Объединенный календарь в формате iCalendar
 */
async function getGroupCalendar(group, cached = null) {
    let currentWeek, nextWeek;

    if (cached && cached.week0 && cached.week1) {
        currentWeek = cached.week0;
        nextWeek = cached.week1;
    } else {
        const client = new sirinium.Client();
        await client.getInitialData();

        await client.changeWeek(0);
        currentWeek = await client.getGroupSchedule(group);

        await client.changeWeek(1);
        nextWeek = await client.getGroupSchedule(group);
    }

    const allEvents = [...currentWeek, ...nextWeek];

    return createICSCalendar(allEvents, `Расписание ${group}`);
}

/**
 * Получает расписание преподавателя на текущую и следующую недели в одном календаре
 * @param {string} teacherId - ID преподавателя
 * @param {Object|null} cached - Кэшированные данные { week0: [...], week1: [...] }
 * @returns {Promise<string>} - Объединенный календарь в формате iCalendar
 */
async function getTeacherCalendar(teacherId, cached = null) {
    let currentWeek, nextWeek;

    if (cached && cached.week0 && cached.week1) {
        currentWeek = cached.week0;
        nextWeek = cached.week1;
    } else {
        const client = new Teacher();
        await client.getInitialData();

        await client.changeWeek(0);
        currentWeek = await client.getSchedule(teacherId);

        await client.changeWeek(1);
        nextWeek = await client.getSchedule(teacherId);
    }

    const allEvents = [...currentWeek, ...nextWeek];

    // Объединяем события с одинаковым временем
    const mergedEvents = mergeEventsByTime(allEvents);

    return createICSCalendar(mergedEvents, `Расписание преподавателя`, true);
}

module.exports = {
    getGroupCalendar,
    getTeacherCalendar,
    
    createICSCalendar,
    createICSEvent,
    formatDateForICS,
    mergeEventsByTime
}