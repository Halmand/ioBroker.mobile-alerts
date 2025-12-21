'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const cheerio = require('cheerio');

class MobileAlerts extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'mobile-alerts',
    });

    this.on('ready', this.onReady.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.pollTimer = null;
    this.windUnit = 'm/s';
  }

  async onReady() {
    try {
      const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
      const pollInterval = Number(this.config.pollInterval || 300);
      this.windUnit = this.config.windUnit || 'm/s';

      if (!phoneIds.length) {
        this.log.error('Keine PhoneID angegeben!');
        return;
      }

      // initial fetch
      for (const id of phoneIds) {
        try {
          await this.fetchData(id);
        } catch (e) {
          // Fehler bereits geloggt in fetchData
        }
      }

      // poll timer
      this.pollTimer = setInterval(() => {
        phoneIds.forEach(id => {
          this.fetchData(id).catch(() => {});
        });
      }, pollInterval * 1000);

    } catch (err) {
      this.log.error(`onReady Fehler: ${err && err.message}`);
    }
  }

  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.log.info('Adapter stopped');
      callback();
    } catch (e) {
      callback();
    }
  }

  // ---------------------------
  // fetchData: holt Seite, parst Sensoren, legt States an
  // Struktur: <phoneId>.Phone_<phoneId>.<SensorName>.<feld>
  // ---------------------------
  async fetchData(phoneId) {
    try {
      if (!phoneId) {
        this.log && this.log.warn && this.log.warn('fetchData: kein phoneId übergeben');
        return;
      }

      const encoded = encodeURIComponent(phoneId);
      const url = `https://measur[...]/${encoded}/SensorsOverview`; // <-- anpassen falls nötig
      this.log.debug(`Abruf: ${url}`);

      const resp = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'iobroker-mobile-alerts/1.0 (+https://github.com/your-repo)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      const html = resp.data;
      const $ = cheerio.load(html);

      // Beispiel: Annahme: jeder Sensor ist in einem container mit Klasse .sensor (anpassen falls Seite abweicht)
      const sensors = [];

      // Probe: mehrere mögliche DOM-Layouts berücksichtigen
      $('.sensor, .device, .card').each((i, el) => {
        try {
          const el$ = $(el);
          let name = el$.find('.name, .title, h3, h4').first().text().trim();
          if (!name) {
            name = `Sensor_${i+1}`;
          }
          // kompletten Text als Rohtext speichern (für spätere Label-Checks)
          const rawText = el$.text().replace(/\s+/g, ' ').trim();

          // Versuche Label/Value Paare robust zu extrahieren:
          const data = {};
          // 1) table rows (th/td or td/td)
          el$.find('tr').each((r, row) => {
            const th = $(row).find('th').first().text().trim();
            const tds = $(row).find('td');
            const val = tds.length ? $(tds[0]).text().trim() : '';
            if (th) data[this._keyify(th)] = val;
          });
          // 2) dl dt/dd
          el$.find('dt').each((d, dt) => {
            const key = $(dt).text().trim();
            const dd = $(dt).next('dd').text().trim();
            if (key) data[this._keyify(key)] = dd;
          });
          // 3) label/value pairs (span.label + span.value or div.label/value)
          el$.find('.label').each((l, lab) => {
            const key = $(lab).text().trim();
            const val = $(lab).siblings('.value').first().text().trim() || $(lab).next().text().trim();
            if (key) data[this._keyify(key)] = val;
          });
          // 4) fallback: lines like "Temperature: 12.3 °C"
          const lines = rawText.split(/[\r\n]/).map(s => s.trim()).filter(Boolean);
          lines.forEach(line => {
            const m = line.match(/^\s*([^:]{2,40}?):\s*([-+]?[\d.,]+)\s*([^\d\s]*)/);
            if (m) {
              data[this._keyify(m[1])] = m[2].replace(',', '.');
            }
          });

          // Map some common keys to normalized field names
          const normalized = this._normalizeSensorData(data);

          sensors.push({
            name: this._safeName(name),
            rawText,
            data: normalized,
          });
        } catch (e) {
          this.log.debug(`Parser Fehler für Sensor ${i}: ${e && e.message}`);
        }
      });

      // Falls keine .sensor gefunden wurden, versuche generellen Fallback: suche nach "Temperatur" etc. im ganzen Document
      if (!sensors.length) {
        this.log.debug('Keine .sensor Elemente gefunden, genereller Fallback versuche Werte im ganzen HTML');
        const whole = $('body').text().replace(/\s+/g, ' ').trim();
        const fallback = {};
        const findNumber = (labelRegex) => {
          const re = new RegExp(labelRegex + '\\s*[:\\-]?\\s*([-+]?\\d+[\\d.,]*)', 'i');
          const mm = whole.match(re);
          return mm ? mm[1].replace(',', '.') : null;
        };
        const t = findNumber('Temperatur|Temperature|Temp');
        if (t) fallback.temperature = t;
        if (Object.keys(fallback).length) {
          sensors.push({
            name: 'Fallback',
            rawText: whole,
            data: this._normalizeSensorData(fallback),
          });
        }
      }

      // Jetzt States anlegen/aktualisieren
      const baseRoot = phoneId; // z. B. "12345"
      const phoneNode = `Phone_${phoneId}`; // Zwischennode: Phone_12345

      // Plausibilitätsbereiche für numerische Felder
      const numericRanges = {
        temperature: { min: -50, max: 60 },
        humidity: { min: 0, max: 100 },
        rain: { min: 0, max: 100000 },
        wind: { min: 0, max: 300 },
        battery: { min: 0, max: 100 },
      };

      for (const sensor of sensors) {
        const sensorIdSafe = sensor.name || 'Sensor';
        const base = `${baseRoot}.${phoneNode}.${sensorIdSafe}`;

        // Metadaten-Objekt für Sensor (Name)
        await this.setObjectNotExistsAsync(`${base}`, {
          type: 'device',
          common: { name: sensor.name },
          native: {},
        });

        // always set id and timestamp if present
        sensor.data.timestamp && await this._createStateAndSet(base, 'timestamp', sensor.data.timestamp, { role: 'value.time', type: 'string' });

        // Iterate fields
        for (const [key, rawVal] of Object.entries(sensor.data)) {
          if (key === 'timestamp') continue;

          let val = rawVal;
          // normalize numeric strings
          if (typeof val === 'string' && val.match(/^[-+]?[\d.,]+$/)) {
            val = Number(val.replace(',', '.'));
          }

          // Determine if numeric expected
          const expectsNumber = Object.keys(numericRanges).some(k => key.includes(k));
          if (expectsNumber) {
            const n = Number(val);
            if (!isFinite(n) || isNaN(n)) {
              this.log.debug(`Überspringe ${key} für ${sensor.name}: kein gültiger numerischer Wert (${val})`);
              continue;
            }
            const rangeKey = Object.keys(numericRanges).find(k => key.includes(k));
            const { min, max } = numericRanges[rangeKey];
            if (n < min || n > max) {
              this.log.warn(`Überspringe ${key} für ${sensor.name}: Wert ${n} ausserhalb Bereich ${min}-${max}`);
              continue;
            }
            // special conversions
            if (key.includes('wind')) {
              const conv = this.convertWind(Number(n));
              await this._createStateAndSet(base, key, conv, { role: this.mapRole(key), type: 'number', unit: this.mapUnit(key) });
            } else {
              await this._createStateAndSet(base, key, Number(n), { role: this.mapRole(key), type: 'number', unit: this.mapUnit(key) });
            }
          } else {
            // For non-numeric: check label existence in rawText for some ambiguous fields
            const ambiguousLabels = {
              temperature_cable: ['kabel', 'kabelsensor'],
              temperature_out: ['aussen', 'außen', 'outside'],
              wet: ['nass', 'wet'],
            };
            if (Object.keys(ambiguousLabels).some(k => key.includes(k))) {
              const labels = ambiguousLabels[Object.keys(ambiguousLabels).find(k => key.includes(k))];
              const found = labels.some(lbl => new RegExp(lbl, 'i').test(sensor.rawText));
              if (!found) {
                this.log.debug(`Überspringe ${key} für ${sensor.name}: Label nicht gefunden im Rohtext`);
                continue;
              }
            }

            // set string/boolean
            const type = (typeof val === 'boolean') ? 'boolean' : 'string';
            await this._createStateAndSet(base, key, val, { role: this.mapRole(key), type, unit: this.mapUnit(key) });
          }
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für ${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });

    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) {
        this.log && this.log.error && this.log.error(`fetchData: 404 für phoneId=${phoneId}`);
      } else {
        this.log && this.log.error && this.log.error(`Fehler beim Abruf für ${phoneId}: ${err && err.message}`);
      }
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  // ---------------------------
  // Hilfsfunktionen
  // ---------------------------

  // Normalisiert Rohkeys zu maschinenfreundlichen keys
  _keyify(label) {
    if (!label) return '';
    return label.toLowerCase()
      .replace(/°/g, '')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
  }

  // Sicherheitsname für Sensor (keine Sonderzeichen)
  _safeName(name) {
    return name.replace(/[^\wäöüÄÖÜß\-]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // Normalisiert einige häufige Feldnamen
  _normalizeSensorData(data) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      let key = k;
      // map common variants
      if (/temp|temperatur|temperature/.test(k)) key = 'temperature';
      if (/humidity|feuchte/.test(k)) key = 'humidity';
      if (/rain|regen/.test(k)) key = 'rain';
      if (/wind/.test(k)) key = 'wind_speed';
      if (/gust/.test(k)) key = 'wind_gust';
      if (/battery|akku/.test(k)) key = 'battery';
      if (/time|zeit/.test(k)) key = 'timestamp';
      if (/wet|nass/.test(k)) key = 'wet';
      out[key] = v;
    }
    return out;
  }

  // Helper: create state if not exists and set value
  async _createStateAndSet(base, key, val, meta = {}) {
    const id = `${base}.${key}`;
    const common = {
      name: key,
      type: meta.type || (typeof val === 'number' ? 'number' : (typeof val === 'boolean' ? 'boolean' : 'string')),
      role: meta.role || this.mapRole(key),
      read: true,
      write: false,
      unit: meta.unit || this.mapUnit(key),
    };
    await this.setObjectNotExistsAsync(id, {
      type: 'state',
      common,
      native: {},
    });
    await this.setStateAsync(id, { val: (common.type === 'number' ? Number(val) : val), ack: true });
  }

  convertWind(v) {
    if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
    if (this.windUnit === 'bft') return +Math.round(Math.pow(v / 0.836, 2 / 3));
    return v;
  }

  mapRole(k) {
    k = k.toLowerCase();
    if (k.includes('temperature')) return 'value.temperature';
    if (k.includes('humidity')) return 'value.humidity';
    if (k.includes('rain')) return 'value.rain';
    if (k.includes('wind')) return 'value.wind';
    if (k.includes('battery')) return 'indicator.battery';
    if (k.includes('timestamp') || k.includes('time')) return 'value.time';
    if (k === 'wet') return 'sensor.water';
    return 'state';
  }

  mapUnit(k) {
    k = k.toLowerCase();
    if (k.includes('temperature')) return '°C';
    if (k.includes('humidity')) return '%';
    if (k.includes('rain')) return 'mm';
    if (k.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    if (k.includes('battery')) return '%';
    return '';
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
