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
  }

  async onReady() {
    const phoneIds = (this.config.phoneId || '').split(',').map(p => p.trim()).filter(Boolean);
    const pollInterval = this.config.pollInterval || 300;
    this.windUnit = this.config.windUnit || 'm/s';

    if (!phoneIds.length) {
      this.log.error('Keine PhoneID angegeben!');
      return;
    }

    // Initialer Abruf
    for (const id of phoneIds) {
      await this.fetchData(id);
    }

    // Polling einrichten
    this.pollTimer = setInterval(() => {
      phoneIds.forEach(id => this.fetchData(id));
    }, pollInterval * 1000);
  }

  async onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.log.info('Adapter wurde gestoppt');
      callback();
    } catch (err) {
      callback();
    }
  }

  convertWind(v) {
    if (!v || isNaN(v)) return 0;
    if (this.windUnit === 'km/h') return +(v * 3.6).toFixed(1);
    if (this.windUnit === 'bft') {
      const bft = Math.round(Math.pow(v / 0.836, 2 / 3));
      return bft > 12 ? 12 : bft;
    }
    if (this.windUnit === 'mph') return +(v * 2.23694).toFixed(1);
    if (this.windUnit === 'kn') return +(v * 1.94384).toFixed(1);
    return +v.toFixed(1);
  }

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const res = await axios.get(url, { timeout: 15000 });
      const html = res.data;
      const $ = cheerio.load(html);

      const sensors = [];

      // 🔍 NEUE EINFACHE METHODE: Direktes Parsing der Tabellendaten
      // Mobile-Alerts verwendet jetzt Tabellen mit der Klasse "table-striped"
      $('.table-striped, table.table, div.panel').each((tableIndex, table) => {
        const $table = $(table);
        const tableText = $table.text().trim().replace(/\s+/g, ' ');
        
        // Sensor-Name extrahieren (vor der Tabelle oder aus Überschrift)
        let sensorName = 'Sensor_' + (tableIndex + 1);
        
        // Suche nach Überschrift vor der Tabelle
        const $prevHeader = $table.prevAll('h4, h3, h2, .panel-heading').first();
        if ($prevHeader.length) {
          const headerText = $prevHeader.text().trim();
          if (headerText && !headerText.includes('Phone ID') && !headerText.includes('Überblick')) {
            sensorName = headerText;
          }
        }
        
        // Extrahiere Sensor-ID
        const idMatch = tableText.match(/ID\s+([A-F0-9]+)/i);
        const sensorId = idMatch ? idMatch[1] : null;
        
        // Extrahiere Zeitstempel
        const timeMatch = tableText.match(/Zeitpunkt\s+([\d.:\s]+\d{4})/i);
        const timestamp = timeMatch ? timeMatch[1].trim() : null;
        
        // Batteriestatus
        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(tableText)) battery = 'low';
        
        const sensorData = {
          id: sensorId,
          timestamp: timestamp,
          battery: battery
        };
        
        // 🔧 EXTRAHIERE ALLE DATEN AUS DER TABELLE
        // Temperaturwerte (alle Formate)
        const tempMatches = tableText.matchAll(/(?:Temperatur|Temp)[\s:]*(?:Innen|In|Außen|Aus|Aussen|Kabel)?[\s:]*([-\d,]+)\s*°?C/gi);
        for (const match of tempMatches) {
          const value = parseFloat(match[1].replace(',', '.'));
          if (!isNaN(value)) {
            const context = match[0].toLowerCase();
            if (context.includes('außen') || context.includes('aussen') || context.includes('aus')) {
              sensorData.temperature_out = value;
            } else if (context.includes('kabel')) {
              sensorData.temperature_cable = value;
            } else if (context.includes('innen') || context.includes('in')) {
              sensorData.temperature_in = value;
            } else {
              sensorData.temperature = value;
            }
          }
        }
        
        // Luftfeuchtewerte
        const humMatches = tableText.matchAll(/(?:Luftfeuchte|Hum|Feuchte)[\s:]*(?:Innen|In|Außen|Aus|Aussen)?[\s:]*([\d,]+)\s*%/gi);
        for (const match of humMatches) {
          const value = parseFloat(match[1].replace(',', '.'));
          if (!isNaN(value)) {
            const context = match[0].toLowerCase();
            if (context.includes('außen') || context.includes('aussen') || context.includes('aus')) {
              sensorData.humidity_out = value;
            } else if (context.includes('innen') || context.includes('in')) {
              sensorData.humidity_in = value;
            } else {
              sensorData.humidity = value;
            }
          }
        }
        
        // Regen
        const rainTotalMatch = tableText.match(/(?:Regen[\s:]*(?:Gesamt|Total)?|Gesamt[\s:]*Regen)[\s:]*([\d,]+)\s*mm/i);
        if (rainTotalMatch) {
          sensorData.rain_total = parseFloat(rainTotalMatch[1].replace(',', '.'));
        }
        
        const rainRateMatch = tableText.match(/Rate[\s:]*([\d,]+)\s*mm\/h/i);
        if (rainRateMatch) {
          sensorData.rain_rate = parseFloat(rainRateMatch[1].replace(',', '.'));
        }
        
        // Wind
        const windSpeedMatch = tableText.match(/Windgeschwindigkeit[\s:]*([\d,]+)\s*m\/s/i);
        if (windSpeedMatch) {
          sensorData.wind_speed = this.convertWind(parseFloat(windSpeedMatch[1].replace(',', '.')));
        }
        
        const windGustMatch = tableText.match(/Böe[\s:]*([\d,]+)\s*m\/s/i);
        if (windGustMatch) {
          sensorData.wind_gust = this.convertWind(parseFloat(windGustMatch[1].replace(',', '.')));
        }
        
        const windDirMatch = tableText.match(/Windrichtung[\s:]*([A-Za-zäöüß]+|\d{1,3}°)/i);
        if (windDirMatch) {
          sensorData.wind_dir = windDirMatch[1];
        }
        
        // Feuchtesensor (trocken/feucht)
        if (tableText.includes('Feuchtesensor') || tableText.includes('Bodenfeuchte')) {
          const wetMatch = tableText.match(/(trocken|feucht)/i);
          if (wetMatch) {
            sensorData.wet = wetMatch[1].toLowerCase() === 'feucht';
          }
        }
        
        // Kontaktsensor
        if (tableText.includes('Kontaktsensor')) {
          if (tableText.includes('Geschlossen')) {
            sensorData.contact = 'closed';
          } else if (tableText.includes('Offen') || tableText.includes('Open')) {
            sensorData.contact = 'open';
          }
        }
        
        // Nur Sensor hinzufügen, wenn Daten vorhanden
        const hasData = Object.keys(sensorData).some(key => 
          !['id', 'timestamp', 'battery'].includes(key) && sensorData[key] !== null && sensorData[key] !== undefined
        );
        
        if (hasData || sensorId) {
          sensors.push({
            name: sensorName,
            ...sensorData
          });
        }
      });

      // Fallback: Wenn keine Tabellen gefunden wurden, gesamten Text durchsuchen
      if (!sensors.length) {
        const fullText = $('body').text().trim().replace(/\s+/g, ' ');
        if (fullText.length > 100) {
          // Versuche, Sensoren aus dem gesamten Text zu extrahieren
          const sensorSections = fullText.split(/(?=\b(ID\s+[A-F0-9]+\b|Sensor|Temperatur|Luftfeuchte))/i);
          
          for (const section of sensorSections) {
            if (section.length > 50) {
              const sensorNameMatch = section.match(/^(.*?)(?=\s+ID\s+|$)/);
              const sensorName = sensorNameMatch ? sensorNameMatch[1].trim() : `Sensor_${sensors.length + 1}`;
              
              const sensorData = {};
              
              // Extrahiere Daten aus diesem Abschnitt
              this.extractDataFromText(section, sensorData);
              
              if (Object.keys(sensorData).length > 0) {
                sensors.push({ name: sensorName, ...sensorData });
              }
            }
          }
        }
      }

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für Phone_${phoneId}`);
        return;
      }

      // 💾 Objekte erstellen und Daten speichern
      for (const sensor of sensors) {
        const base = `Phone_${phoneId}.${sensor.name.replace(/[^\wäöüßÄÖÜ]/g, '_').replace(/_+/g, '_')}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId, sensorId: sensor.id },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name', 'id'].includes(key)) continue;
          
          const stateId = `${base}.${key}`;
          
          await this.setObjectNotExistsAsync(stateId, {
            type: 'state',
            common: {
              name: this.getFriendlyName(key),
              type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string',
              role: this.mapRole(key),
              read: true,
              write: false,
              unit: this.mapUnit(key),
            },
            native: {},
          });

          await this.setStateAsync(stateId, { val, ack: true });
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für Phone_${phoneId}`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für Phone_${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  extractDataFromText(text, data) {
    // Hilfsfunktion für sicheres Parsen
    const safeParse = (str) => {
      const num = parseFloat(str.replace(',', '.'));
      return isNaN(num) ? null : num;
    };

    // Sensor-ID
    const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
    if (idMatch) data.id = idMatch[1];

    // Zeitstempel
    const timeMatch = text.match(/Zeitpunkt\s+([\d.:\s]+\d{4})/i);
    if (timeMatch) data.timestamp = timeMatch[1].trim();

    // Batterie
    if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) data.battery = 'low';
    else data.battery = 'ok';

    // Temperatur (alle Varianten)
    const tempRegex = /Temperatur(?:\s+(?:Innen|In|Außen|Aus|Aussen|Kabel))?\s*[:=]?\s*([-\d,]+)\s*°?C/gi;
    let tempMatch;
    while ((tempMatch = tempRegex.exec(text)) !== null) {
      const value = safeParse(tempMatch[1]);
      if (value !== null) {
        const context = tempMatch[0].toLowerCase();
        if (context.includes('außen') || context.includes('aussen') || context.includes('aus')) {
          data.temperature_out = value;
        } else if (context.includes('kabel')) {
          data.temperature_cable = value;
        } else if (context.includes('innen') || context.includes('in')) {
          data.temperature_in = value;
        } else {
          data.temperature = value;
        }
      }
    }

    // Luftfeuchte (alle Varianten)
    const humRegex = /Luftfeuchte(?:\s+(?:Innen|In|Außen|Aus|Aussen))?\s*[:=]?\s*([\d,]+)\s*%/gi;
    let humMatch;
    while ((humMatch = humRegex.exec(text)) !== null) {
      const value = safeParse(humMatch[1]);
      if (value !== null) {
        const context = humMatch[0].toLowerCase();
        if (context.includes('außen') || context.includes('aussen') || context.includes('aus')) {
          data.humidity_out = value;
        } else if (context.includes('innen') || context.includes('in')) {
          data.humidity_in = value;
        } else {
          data.humidity = value;
        }
      }
    }

    // Weitere Sensordaten wie Wind, Regen etc. (vereinfacht)
    const windSpeedMatch = text.match(/Windgeschwindigkeit\s*[:=]?\s*([\d,]+)\s*m\/s/i);
    if (windSpeedMatch) {
      const value = safeParse(windSpeedMatch[1]);
      if (value !== null) data.wind_speed = this.convertWind(value);
    }

    const windGustMatch = text.match(/Böe\s*[:=]?\s*([\d,]+)\s*m\/s/i);
    if (windGustMatch) {
      const value = safeParse(windGustMatch[1]);
      if (value !== null) data.wind_gust = this.convertWind(value);
    }
  }

  mapRole(key) {
    const roles = {
      temperature: 'value.temperature',
      temperature_in: 'value.temperature',
      temperature_out: 'value.temperature',
      temperature_cable: 'value.temperature',
      humidity: 'value.humidity',
      humidity_in: 'value.humidity',
      humidity_out: 'value.humidity',
      rain_total: 'value.rain',
      rain_rate: 'value.rain',
      wind_speed: 'value.wind',
      wind_gust: 'value.wind',
      wind_dir: 'value.wind',
      battery: 'indicator.battery',
      timestamp: 'value.time',
      wet: 'sensor.water',
      contact: 'sensor.door',
    };
    return roles[key] || 'state';
  }

  mapUnit(key) {
    const units = {
      temperature: '°C',
      temperature_in: '°C',
      temperature_out: '°C',
      temperature_cable: '°C',
      humidity: '%',
      humidity_in: '%',
      humidity_out: '%',
      rain_total: 'mm',
      rain_rate: 'mm/h',
      wind_speed: this.windUnit === 'km/h' ? 'km/h' : this.windUnit === 'bft' ? 'Bft' : 'm/s',
      wind_gust: this.windUnit === 'km/h' ? 'km/h' : this.windUnit === 'bft' ? 'Bft' : 'm/s',
    };
    return units[key] || '';
  }

  getFriendlyName(key) {
    const names = {
      temperature: 'Temperatur',
      temperature_in: 'Temperatur Innen',
      temperature_out: 'Temperatur Außen',
      temperature_cable: 'Temperatur Kabel',
      humidity: 'Luftfeuchte',
      humidity_in: 'Luftfeuchte Innen',
      humidity_out: 'Luftfeuchte Außen',
      rain_total: 'Regen Gesamt',
      rain_rate: 'Regen Rate',
      wind_speed: 'Windgeschwindigkeit',
      wind_gust: 'Windböe',
      wind_dir: 'Windrichtung',
      battery: 'Batterie',
      timestamp: 'Letzte Aktualisierung',
      wet: 'Feuchtigkeit',
      contact: 'Kontaktstatus',
    };
    return names[key] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
