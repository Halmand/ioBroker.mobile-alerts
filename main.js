/* jshint -W097 */ 
/* jslint node: true */
"use strict";

const xml2js = require("xml2js");
const utils = require(__dirname + "/lib/utils");
const request = require("request");

const adapter = utils.adapter("mobile-alerts");

let timer = null;

adapter.on("unload", (callback) => {
    try {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        adapter.log.debug("cleaned everything up...");
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on("objectChange", (id, obj) => {
    adapter.log.debug(`objectChange ${id} ${JSON.stringify(obj)}`);
});

adapter.on("stateChange", (id, state) => {
    adapter.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);
    if (state && !state.ack) {
        adapter.log.debug("ack is not set!");
    }
});

adapter.on("message", (obj) => {
    if (typeof obj === "object" && obj.message) {
        if (obj.command === "send") {
            adapter.log.info("send command received");
            if (obj.callback) {
                adapter.sendTo(obj.from, obj.command, "Message received", obj.callback);
            }
        }
    }
});

adapter.on("ready", () => {
    main();
});

function main() {
    adapter.log.info("Adapter ready, starte Datenabruf");

    // Intervall aus Konfiguration (in Minuten)
    const intervalMin = adapter.config.intervalMin || 14;
    const intervalMs = intervalMin * 60 * 1000;

    // Direkt starten
    fetchAndProcess();

    // Intervall starten
    timer = setInterval(fetchAndProcess, intervalMs);
}

function fetchAndProcess() {
    const ma_hostname = adapter.config.hostname;
    const ma_phoneId = adapter.config.phoneId;
    const ma_path = adapter.config.path || "/Home/SensorsOverview";

    if (!ma_hostname || !ma_phoneId) {
        adapter.log.error("Hostname oder phoneId nicht konfiguriert");
        return;
    }

    const url = `https://${ma_hostname}${ma_path}`;

    const headers = {
        "User-Agent": "Mozilla/5.0 (ioBroker mobile-alerts)",
        "Content-Type": "application/x-www-form-urlencoded",
    };

    const options = {
        url: url,
        method: "POST",
        headers: headers,
        form: { phoneid: ma_phoneId },
        timeout: 15000,
    };

    adapter.log.debug(`Rufe URL auf: ${url} mit phoneId=${ma_phoneId}`);

    request(options, (error, response, body) => {
        if (error) {
            adapter.log.error(`HTTP-Request Fehler: ${error}`);
            return;
        }
        if (!response || response.statusCode !== 200) {
            adapter.log.error(`Ungültiger HTTP-Status: ${response?.statusCode}`);
            adapter.log.debug(`Body: ${body}`);
            return;
        }

        adapter.log.debug("Daten erhalten vom Server, beginne Parsen");
        parseHtml(body);
    });
}

function parseHtml(html) {
    // Wir versuchen, nur die interessanten Tags herauszufiltern
    const matches = html.match(/(<h[45]>.*?<\/h[45]>|<a .*?deviceid=.*?<\/a>)/gim);
    if (!matches) {
        adapter.log.error("Keine gültigen Daten im HTML gefunden");
        adapter.log.debug(`HTML Inhalt: ${html}`);
        return;
    }

    const xmlFragment = matches.join("");
    adapter.log.debug(`XML-Fragment: ${xmlFragment}`);

    const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true,
    });

    parser.parseString(xmlFragment, (err, result) => {
        if (err) {
            adapter.log.error("Fehler beim Parsen: " + err);
            return;
        }
        if (!result || (!result.a && (!result.h4 || !result.h5))) {
            adapter.log.error("Erwartete Tags nicht gefunden im Parsergebnis");
            adapter.log.debug("Parsergebnis: " + JSON.stringify(result));
            return;
        }

        try {
            handleParsed(result);
        } catch (e) {
            adapter.log.error("Fehler in handleParsed: " + e);
        }
    });
}

async function handleParsed(result) {
    // Ergebnis kann eine Struktur mit result.a (Array oder Einzelobjekt) sein
    let arrA = [];
    if (Array.isArray(result.a)) {
        arrA = result.a;
    } else if (result.a) {
        arrA = [result.a];
    }

    // h4 und h5 entsprechend behandeln
    let arrH4 = [];
    if (Array.isArray(result.h4)) {
        arrH4 = result.h4;
    } else if (result.h4) {
        arrH4 = [result.h4];
    }

    let arrH5 = [];
    if (Array.isArray(result.h5)) {
        arrH5 = result.h5;
    } else if (result.h5) {
        arrH5 = [result.h5];
    }

    // Zuerst: Geräte (Device-Objekte)
    for (let i = 0; i < arrA.length; i++) {
        const aObj = arrA[i];
        if (!aObj["#"] || !aObj.href) continue;
        const deviceName = aObj["#"].trim();
        const href = aObj.href;
        const deviceId = getHrefParamValue(href, "deviceid");
        if (!deviceId) continue;

        await adapter.setObjectNotExistsAsync(deviceId, {
            type: "device",
            common: {
                name: deviceName,
                type: "string",
                role: "sensor",
                read: true,
                write: false,
            },
            native: {},
        });
    }

    // Objekte (States) anlegen
    for (let i = 0; i < arrH4.length && i < arrH5.length; i++) {
        const key = arrH5[i];
        const value = arrH4[i];
        if (!key || !value) continue;

        if (key === "ID") {
            // ist Kennung des Geräts, wird als deviceId genutzt
            // nichts tun hier
        } else {
            const normalizedKey = normalize(key);
            // Für jedes Gerät: Wir legen ein State unter deviceId.normalizedKey an
            // Aber: Wir brauchen das passende deviceId für diese Position i
            // Dafür: wir suchen aus arrH4/H5 oder arrA, welcher deviceId zu diesem Index gehört
            // Eine einfache Heuristik: wenn arrA[i] existiert und hat href, nutze diesen deviceId
            let deviceId = null;
            if (arrA[i] && arrA[i].href) {
                deviceId = getHrefParamValue(arrA[i].href, "deviceid");
            }
            if (!deviceId) {
                // fallback: falls kein passendes a-Objekt in diesem Index, überspringen
                continue;
            }

            await adapter.setObjectNotExistsAsync(deviceId + "." + normalizedKey, {
                type: "state",
                common: {
                    name: key,
                    type: "string",
                    role: "value",
                    read: true,
                    write: false,
                },
                native: {},
            });
        }
    }

    // States setzen
    for (let i = 0; i < arrH4.length && i < arrH5.length; i++) {
        const key = arrH5[i];
        const value = arrH4[i];
        if (!key || !value) continue;

        if (key === "ID") {
            continue;
        } else {
            const normalizedKey = normalize(key);
            let deviceId = null;
            if (arrA[i] && arrA[i].href) {
                deviceId = getHrefParamValue(arrA[i].href, "deviceid");
            }
            if (!deviceId) {
                continue;
            }

            const formatted = formatNum(value);
            await adapter.setStateAsync(deviceId + "." + normalizedKey, {
                val: formatted,
                ack: true,
            });
        }
    }

    adapter.log.info("Daten verarbeitet und States gesetzt");
}

function formatNum(s) {
    let extractNumbers = adapter.config.extractNumbers;
    if (extractNumbers) {
        const patternNumber = /^(-|\+)?\d+(,|\.)?\d* *(C|F|%|mm|km\/h|hPa|m\/s)$/;
        if (patternNumber.test(s)) {
            s = s.replace(",", ".");
            return parseFloat(s);
        }
    }
    return s;
}

function normalize(s) {
    let str = s.toLowerCase();
    str = str.replace(/ /g, "_");
    str = str.replace(/ä/g, "ae");
    str = str.replace(/ö/g, "oe");
    str = str.replace(/ü/g, "ue");
    str = str.replace(/ß/g, "ss");
    return str;
}

function getHrefParamValue(href, paramName) {
    const parts = href.split("?");
    if (parts.length < 2) return null;
    const query = parts[1];
    const params = query.split("&");
    for (const p of params) {
        const kv = p.split("=");
        if (kv[0] === paramName) {
            return kv[1];
        }
    }
    return null;
}
