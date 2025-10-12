"use strict";

const xml2js = require("xml2js");
const utils = require(__dirname + "/lib/utils");
const request = require("request");

const adapter = utils.adapter("mobile-alerts");
let timer = null;

adapter.on("unload", (callback) => {
    try {
        if (timer) clearInterval(timer);
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on("ready", () => {
    main();
});

function main() {
    const hostname = adapter.config.hostname || "measurements.mobile-alerts.eu";
    const phoneId = adapter.config.phoneId;
    const path = adapter.config.path || "/Home/SensorsOverview";
    const interval = (parseInt(adapter.config.intervalMin) || 14) * 60 * 1000;

    if (!phoneId) {
        adapter.log.error("Phone ID ist nicht gesetzt!");
        return;
    }

    fetchData(hostname, path, phoneId);
    timer = setInterval(() => fetchData(hostname, path, phoneId), interval);
}

function fetchData(hostname, path, phoneId) {
    const url = `https://${hostname}${path}`;
    const options = {
        url: url,
        method: "POST",
        headers: {
            "User-Agent": "ioBroker.mobile-alerts",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        form: { phoneid: phoneId },
        timeout: 15000
    };

    request(options, (error, response, body) => {
        if (error || response.statusCode !== 200) {
            adapter.log.error(`Fehler beim Abruf: ${error || response.statusCode}`);
            return;
        }

        const matches = body.match(/(<h[45]>.*?<\/h[45]>|<a .*?deviceid=.*?<\/a>)/gim);
        if (!matches) {
            adapter.log.error("Keine Daten im HTML gefunden.");
            return;
        }

        parseHtml(matches.join(""));
    });
}

function parseHtml(html) {
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    parser.parseString(html, async (err, result) => {
        if (err || !result) {
            adapter.log.error("Fehler beim Parsen: " + err);
            return;
        }

        try {
            await handleParsed(result);
        } catch (e) {
            adapter.log.error("Fehler beim Verarbeiten: " + e);
        }
    });
}

async function handleParsed(result) {
    const entries = Array.isArray(result.a) ? result.a : [result.a];
    const h4 = Array.isArray(result.h4) ? result.h4 : [result.h4];
    const h5 = Array.isArray(result.h5) ? result.h5 : [result.h5];

    for (let i = 0; i < entries.length; i++) {
        const deviceName = entries[i]["#"].trim();
        const href = entries[i].href;
        const deviceId = getHrefParamValue(href, "deviceid");
        if (!deviceId) continue;

        await adapter.setObjectNotExistsAsync(deviceId, {
            type: "device",
            common: { name: deviceName, type: "string", role: "sensor", read: true, write: false },
            native: {}
        });
    }

    let currentId = null;
    for (let i = 0; i < h5.length; i++) {
        const key = h5[i];
        const value = h4[i];
        if (key === "ID") {
            currentId = value;
            continue;
        }
        if (!currentId) continue;

        const stateId = `${currentId}.${normalize(key)}`;
        await adapter.setObjectNotExistsAsync(stateId, {
            type: "state",
            common: {
                name: key,
                type: "mixed",
                role: "value",
                read: true,
                write: false
            },
            native: {}
