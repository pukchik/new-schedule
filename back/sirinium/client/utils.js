module.exports = {
    getCallMethodUpdateObject: (method, params = []) => {
        return {
            type: "callMethod",
            payload: {
                id: (Math.random() + 1).toString(36).substring(8),
                method: method,
                params: params
            }
        }
    },

    getXsrfToken: async (response) => {
        let sources = [];
        if (typeof response.headers.getSetCookie === 'function') {
            sources = response.headers.getSetCookie();
        }
        const setCookie = response.headers.get('set-cookie') || response.headers.get('Set-Cookie') || '';
        if (setCookie) sources.push(setCookie);
        const cookieStr = sources.join('\n');
        const match = cookieStr.match(/XSRF-TOKEN=([^;\s]+)/);
        if (!match) throw new Error('XSRF token not found in Set-Cookie');
        return match[1];
    },

    getSessionToken: async (response) => {
        let sources = [];
        if (typeof response.headers.getSetCookie === 'function') {
            sources = response.headers.getSetCookie();
        }
        const setCookie = response.headers.get('set-cookie') || response.headers.get('Set-Cookie') || '';
        if (setCookie) sources.push(setCookie);
        const cookieStr = sources.join('\n');
        const match = cookieStr.match(/raspisanie_universitet_sirius_session=([^;\s]+)/);
        if (!match) throw new Error('Session token not found in Set-Cookie');
        return match[1];
    },

    getWireToken: async (body) => {
        const wireTokenRegex = body.match(/window\.livewire_token\s*=\s*['"]([0-9A-Za-z]+)['"]/);
        if (!wireTokenRegex) throw new Error('wire token not found');
        return wireTokenRegex[1];
    },

    parseInitialData: async (body) => {
        const initialDataAttribute = body.match(/wire:initial-data=\"([\s\S]+?)\"/);
        if (!initialDataAttribute) throw new Error('initial data attribute not found');
        const initialDataRawString = initialDataAttribute[1].replaceAll("&quot;", "\"");
        return JSON.parse(initialDataRawString);
    },

    getArrayOfEvents: async (data) => {
        return data.serverMemo.data.events ? Object.values(data.serverMemo.data.events).flat() : [];
    }
};