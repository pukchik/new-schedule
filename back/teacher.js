const utils = require('./utils');
const { setGlobalDispatcher, ProxyAgent, Agent } = require('undici');

// Глобальная настройка undici
try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy || process.env.https_proxy;
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } else {
        setGlobalDispatcher(new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000, connect: { family: 4, hints: 0 } }));
    }
} catch (_) {}

class OurParser {
    constructor(domain, mainGrid) {
        this.url = domain;
        this.mainGridUrl = mainGrid;
        try {
            this.origin = new URL(this.url).origin;
        } catch (e) {
            this.origin = "https://schedule.siriusuniversity.ru";
        }
    }

    async fetchWithRetry(url, options, timeoutMs) {
        const attempts = parseInt(process.env.FETCH_RETRY_ATTEMPTS || '3', 10);
        let currentTimeout = parseInt(timeoutMs || process.env.FETCH_TIMEOUT_MS || '45000', 10);
        const forceInsecure = String(process.env.FETCH_INSECURE_TLS || '').toLowerCase() === '1' || String(process.env.FETCH_INSECURE_TLS || '').toLowerCase() === 'true';
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), currentTimeout);
            try {
                const { Agent } = require('undici');
                const dispatcher = (!forceInsecure && attempt === 1) ? undefined : new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000, connect: { family: 4, rejectUnauthorized: false, hints: 0 } });
                const response = await fetch(url, { ...options, signal: controller.signal, dispatcher });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response;
            } catch (err) {
                if (process.env.DEBUG_FETCH) {
                    const cause = err && err.cause ? err.cause : {};
                    console.error('[teacher ourparser] fetch attempt failed', {
                        attempt,
                        attempts,
                        url,
                        timeoutMs: currentTimeout,
                        name: err?.name,
                        message: err?.message,
                        code: cause?.code,
                        errno: cause?.errno,
                        syscall: cause?.syscall,
                        host: cause?.host,
                        address: cause?.address,
                        port: cause?.port
                    });
                }
                if (attempt === attempts) throw err;
                await new Promise(r => setTimeout(r, 500 * attempt));
                currentTimeout = Math.floor(currentTimeout * 1.5);
            } finally {
                clearTimeout(timer);
            }
        }
    }

    getDefaultHeaders() {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Language": "ru,en;q=0.9",
            "Connection": "keep-alive",
            "Referer": this.url
        };
    }

    async getInitialData() {
        const response = await this.fetchWithRetry(this.url, {
            credentials: "same-origin",
            redirect: "follow",
            headers: this.getDefaultHeaders()
        }, parseInt(process.env.FETCH_TIMEOUT_MS || '45000', 10));
        this.xsrfToken = await utils.getXsrfToken(response);
        this.sessionToken = await utils.getSessionToken(response);

        const body = await response.text();
        const initialData = await utils.parseInitialData(body);
        this.data = initialData;

        this.wireToken = await utils.getWireToken(body);

        await this.emulateResize(1920, 1080);

        return initialData;
    }

    async getTeacherSchedule(teacher){
        const data = await this.sendUpdates(
            [utils.getCallMethodUpdateObject("set", [teacher])]
        );

        return await utils.getArrayOfEvents(data);
    }

    async emulateResize(width, height) {
        const data = await this.sendUpdates([
            utils.getCallMethodUpdateObject("render"),
            utils.getCallMethodUpdateObject("$set", ["width", width]),
            utils.getCallMethodUpdateObject("$set", ["height", height]),
        ]);

        this.data.serverMemo.data.width = data.serverMemo.data.width;
        this.data.serverMemo.data.height = data.serverMemo.data.height;
        this.data.serverMemo.checksum = data.serverMemo.checksum;

        return true;
    }

    async changeWeek(step) {
        const method = step > 0 ? "addWeek" : "minusWeek";
        for (let i = 0; i < Math.abs(step); i++) {
            const data = await this.sendUpdates([utils.getCallMethodUpdateObject(method)]);

            Object.assign(this.data.serverMemo.data, data.serverMemo.data);

            this.data.serverMemo.checksum = data.serverMemo.checksum;
            this.data.serverMemo.htmlHash = data.serverMemo.htmlHash;
        }

        return true;
    }

    async sendUpdates(updates) {
        const data = await this.fetchWithRetry(this.mainGridUrl, {
            method: "POST",
            credentials: "same-origin",
            headers: { ...this.getDefaultHeaders(), ...this.getHeaders(), Referer: this.url, Origin: this.origin },
            body: JSON.stringify({
                ...this.getInitialBody(),
                updates: updates
            })
        }, parseInt(process.env.FETCH_TIMEOUT_MS || '45000', 10));

        return await data.json();
    }

    getInitialBody() {
        return {
            fingerprint: this.data["fingerprint"],
            serverMemo: this.data["serverMemo"]
        };
    }

    getHeaders() {
        return {
            "Cookie": `XSRF-TOKEN=${this.xsrfToken};raspisanie_universitet_sirius_session=${this.sessionToken}`,
            "X-Livewire": "true",
            "X-Csrf-Token": this.wireToken ?? "",
            "Content-Type": "application/json"
        }
    }
}

class Teacher {
    constructor(options = {}) {
        this.options = {
            domain: options.domain ?? "https://schedule.siriusuniversity.ru/teacher",
            url: "https://schedule.siriusuniversity.ru",
        };

        this.parser = new OurParser(this.options.domain, "https://schedule.siriusuniversity.ru/livewire/message/teachers.teacher-main-grid");
    }

    async getSchedule(teacher){
        return await this.parser.getTeacherSchedule(teacher).catch((e) =>{
            throw new Error(e);
        });
    }

    async getInitialData() {
        await this.parser.getInitialData().catch((e) => {
            throw new Error("Can't get inital data: " + e);
        });

        return true;
    }

    async changeWeek(step) {
        if (!Number.isInteger(step) || step === 0) return;

        await this.parser.changeWeek(step).catch((e) => {
            throw new Error("Can't change week: " + e);
        });
    }
}

module.exports = Teacher;
