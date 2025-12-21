/**
 * main.js
 * Parser für die Sensor‑Übersicht (basierend auf deinen Screenshots).
 * - Wandelt "OFL" in 0 um (wie gewünscht)
 * - Unterstützt 0-Werte
 *
 * Benötigt: axios, cheerio
 * Install: npm i axios cheerio
 *
 * Anpassung: setze URL_LIST_PAGE auf die Seite, die die Sensorübersicht liefert.
 */

const axios = require('axios');
const cheerio = require('cheerio');

// Konfiguration
const URL_LIST_PAGE = 'https://example.com/overview'; // <- anpassen
const LOCALE_DECIMAL = ','; // Dezimaltrennzeichen in der HTML (deutsch)
const OFL_AS = 0; // vom Benutzer gewünscht: OFL -> 0

// Hilfsfunktionen
function parseNumberDE(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (str === '' || /^(OFL|ofl)$/i.test(str)) {
    // OFL mapping
    return OFL_AS;
  }
  // Entferne nicht-numerische Zeichen außer - , .
  str = str.replace(/[^\d\-,.]/g, '');
  // Wenn Komma als Dezimaltrenner, ersetze durch Punkt
  // Ersetze nur das letzte Komma (in case thousands are not used)
  if (str.indexOf(',') >= 0 && str.indexOf('.') === -1) {
    // z.B. "21,3" -> "21.3"
    const lastComma = str.lastIndexOf(',');
    str = str.substring(0, lastComma).replace(/,/g, '') + '.' + str.substring(lastComma + 1);
  } else {
    // falls Mischform "1.234,56" -> remove dots, change comma
    if (str.indexOf(',') >= 0) {
      str = str.replace(/\./g, '').replace(',', '.');
    }
  }
  // Entferne mögliche multiple '-' oder '.' am Ende/Anfang
  str = str.replace(/^-+/, '-').replace(/-+/g, '-');
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

function parseIntPercent(str) {
  if (!str) return null;
  if (/^(OFL|ofl)$/i.test(str)) return OFL_AS;
  const m = str.match(/-?[\d,.]+/);
  return m ? Math.round(parseNumberDE(m[0])) : null;
}

function textNormalize(s) {
  return (s || '').replace(/\u00A0/g, ' ').trim();
}

// Hauptparser
async function fetchAndParse(url) {
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const html = res.data;
    const $ = cheerio.load(html);

    // Ergebnisobjekt: key = Sensor-Title oder ID, value = object mit gemessenen Werten
    const sensors = [];

    // Ich nehme an, jeder Sensor ist in einer Box/div-Card.
    // Aus deinen Screenshots: jedes Panel enthält einen Titel (z. B. "Küche", "Regenmenge") und Felder.
    // Wir gehen generisch vor: find cards (divs) mit h3/a/titel; fallback: direkte panels
    // Anpassung je nach Seite möglich.

    // Heuristik: Panels haben class "panel" oder "well" oder sind direkte <div> mit bestimmten child nodes.
    // Wir wählen alle direkten container-Boxen die typischerweise Sensorinfos enthalten:
    const panels = $('div').filter(function () {
      const el = $(this);
      const text = textNormalize(el.text());
      // Heuristische filter: enthält "ID" und "Zeitpunkt" -> ein Sensor-Panel
      return /ID\s|Zeitpunkt/i.test(text) && text.length < 2000 && el.find('input,script').length === 0;
    });

    // Falls panels leer -> fallback: look for elements with "ID" token anywhere
    const maybePanels = panels.length ? panels : $('*:contains("ID"):not(script):not(style)').parent();

    maybePanels.each(function (i, el) {
      const box = $(el);
      const rawText = textNormalize(box.text());
      if (!rawText) return;

      // Versuche Titel zu extrahieren: ein Link/Text oben (z. B. <a>Title</a> oder <h3>)
      let title = '';
      const titleCandidates = box.find('a, h1, h2, h3, .panel-title, .title, strong').first();
      if (titleCandidates && titleCandidates.length) {
        title = textNormalize(titleCandidates.first().text());
      }
      if (!title) {
        // Fallback: erste Zeile des Panels
        title = rawText.split('\n').map(l=>l.trim()).find(l=>l.length>0) || 'unnamed';
      }

      // Extrahiere ID falls vorhanden
      let idMatch = rawText.match(/ID\s*[:\s]?\s*([0-9A-Fa-f]{6,})/);
      let sensorId = idMatch ? idMatch[1] : null;

      // Suche nach typischen Feldern mit Regex
      const sensor = {
        title,
        id: sensorId,
        rawText,
        values: {}
      };

      // ---------------------------------------
      // Regen
      // Ex: "Regen 0,3 mm" oder "Regenmenge 0,3 mm"
      let m = rawText.match(/Regen(?:menge)?[\s:]*([-\d\.,]+)\s*mm/i);
      if (m) {
        sensor.values.rain_mm = parseNumberDE(m[1]);
      } else {
        // Manchmal steht "Regen" in einer eigenen Zeile: suche "Regen" und dann next num mm
        m = rawText.match(/Regen(?:menge)?[\s\S]{0,30}?([-\d\.,]+)\s*mm/i);
        if (m) sensor.values.rain_mm = parseNumberDE(m[1]);
      }

      // ---------------------------------------
      // Temperatur + Luftfeuchte (verschiedene Varianten)
      // Beispiele aus Screenshots:
      // "Temperatur 21,3 C" OR "Temperatur Innen 20,7 C" OR "Temperatur Kabelsensor 10,3 C"
      // "Luftfeuchte 42%"
      const tempPatterns = [
        { key: 'temp', rx: /Temperatur(?:\s*(?:Innen|Innen|Außen|Aussen|Kabelsensor|Kabel|Innenen?)?)?\s*[:\s]*([-\d\.,]+)\s*[°]?\s*[Cc]?/i },
        // generisch: "Temperatur Außen -0,4 C"
      ];
      tempPatterns.forEach(p => {
        const mm = rawText.match(p.rx);
        if (mm) {
          // determine suffix (Innen/Außen/Kabel) by investigating left context
          const left = rawText.slice(Math.max(0, mm.index - 30), mm.index + 1);
          let suffix = null;
          if (/Innen/i.test(left)) suffix = 'inside';
          else if (/Außen|Aussen/i.test(left)) suffix = 'outside';
          else if (/Kabel|Kabelsensor/i.test(left)) suffix = 'cable';
          else suffix = 'ambient';
          sensor.values[`temperature_${suffix}`] = parseNumberDE(mm[1]);
        }
      });

      // Luftfeuchte (Humidity)
      // "Luftfeuchte 42%"
      const humMatches = rawText.match(/Luftfeuchte(?:\s*(?:Innen|Außen|Aussen)?)?[\s:]*([-\d\.,]+)\s*%/ig);
      if (humMatches && humMatches.length) {
        humMatches.forEach(hs => {
          const mm = hs.match(/(Innen|Außen|Aussen)/i);
          let suffix = 'ambient';
          if (mm) {
            if (/Innen/i.test(mm[0])) suffix = 'inside';
            else if (/Außen|Aussen/i.test(mm[0])) suffix = 'outside';
          }
          const valMatch = hs.match(/([-\d\.,]+)\s*%/);
          if (valMatch) sensor.values[`humidity_${suffix}`] = parseIntPercent(valMatch[1]);
        });
      } else {
        // fallback single humidity in panel
        const hum = rawText.match(/Luftfeuchte[\s:]*([-\d\.,]+)\s*%/i);
        if (hum) sensor.values.humidity = parseIntPercent(hum[1]);
      }

      // ---------------------------------------
      // Windsensor
      // "Windgeschwindigkeit 0,0 m/s" "Böe 0,0 m/s" "Windrichtung Ostsüdost"
      const windSpeed = rawText.match(/Wind(?:geschwindigkeit)?[\s:]*([-\d\.,]+)\s*m\/s/i);
      if (windSpeed) sensor.values.wind_speed_ms = parseNumberDE(windSpeed[1]);

      const gust = rawText.match(/B[oö]e[\s:]*([-\d\.,]+)\s*m\/s/i);
      if (gust) sensor.values.wind_gust_ms = parseNumberDE(gust[1]);

      const windDir = rawText.match(/Windrichtung[\s:]*([A-Za-zÄÖÜäöüß\s-]+)/i);
      if (windDir) sensor.values.wind_direction = textNormalize(windDir[1]);

      // ---------------------------------------
      // Kontakt (Tür/Fenster)
      // "Kontaktsensor Geschlossen" oder "Geöffnet"
      const contact = rawText.match(/Kontaktsensor[\s:]*([A-Za-zäöüÄÖÜß]+)/i);
      if (contact) {
        sensor.values.contact = contact[1].toLowerCase().includes('geschlossen') ? 'closed' :
                                contact[1].toLowerCase().includes('geöff') || contact[1].toLowerCase().includes('offen') ? 'open' :
                                contact[1];
      }

      // ---------------------------------------
      // Durchschnittswerte (Wohnzimmer Beispiel)
      // "Durchschn. Luftf. 3H 50%" etc. Wir suchen alle "Durchschn" Vorkommen
      const avgMatches = rawText.match(/Durchschn[^\d\n\r]{0,30}([\d]+[%\s]|OFL|ofl)/ig);
      if (avgMatches && avgMatches.length) {
        // find lines like "Durchschn. Luftf. 3H      50%"
        const lines = rawText.split(/\n/);
        lines.forEach(line => {
          const lm = line.match(/Durchschn.*?(3H|24H|7D|30D)?[^\d\n\r]{0,30}([-\d\.,]+|OFL|ofl)\s*%?/i);
          if (lm) {
            let period = (lm[1] || '').toUpperCase();
            if (!period) period = 'unknown';
            const valRaw = lm[2];
            const val = (/^(OFL|ofl)$/i.test(valRaw) ? OFL_AS : parseIntPercent(valRaw));
            sensor.values[`avg_humidity_${period}`] = val;
          }
        });
      }

      // ---------------------------------------
      // Falls keine Werte gefunden -> skip
      const hasValues = Object.keys(sensor.values).length > 0;
      if (hasValues) sensors.push(sensor);
    });

    return sensors;

  } catch (err) {
    console.error('Fehler beim Abrufen/Parsen:', err && err.message ? err.message : err);
    throw err;
  }
}

// Beispiel: Ausgeben / weiternutzen
(async () => {
  try {
    const sensors = await fetchAndParse(URL_LIST_PAGE);
    console.log('Gefundene Sensoren:', sensors.length);
    // Ausgabe ordentlich
    sensors.forEach(s => {
      console.log('----------------------------------------');
      console.log('Title:', s.title);
      if (s.id) console.log('ID:', s.id);
      console.log('Werte:');
      console.log(JSON.stringify(s.values, null, 2));
    });

    // Hier kannst du die Daten weiterverarbeiten:
    // - in eine Datenbank schreiben
    // - in ioBroker states setzen
    // - MQTT publishen
    // Beispiel: wenn ioBroker verwendet wird, rufe setState(...) entsprechend auf.
  } catch (e) {
    console.error('Script abgebrochen:', e);
  }
})();
