const Client = require("./client");
const { setGlobalDispatcher, ProxyAgent, Agent } = require('undici');

// Конфигурируем undici и здесь тоже (на случай прямого импорта пакета)
try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.http_proxy || process.env.https_proxy;
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } else {
        setGlobalDispatcher(new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000, connect: { family: 4, hints: 0 } }));
    }
} catch (_) {}

module.exports = {
    Client: Client
};