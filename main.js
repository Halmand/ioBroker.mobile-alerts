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

    for (const id of phoneIds) await this.fetchData(id);

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

      // 🔍 ZURÜCK ZUR ORIGINALEN STRUKTUR: H4-basierte Sensoren
      // Mobile-Alerts verwendet H4-Überschriften für jeden Sensor
      $('h4').each((i, el) => {
        const $h4 = $(el);
        const sensorName = $h4.text().trim();
        
        // Überspringen, wenn es sich um eine System-Überschrift handelt
        if (!sensorName || 
            sensorName.includes('Phone ID') || 
            sensorName.includes('Überblick') || 
            sensorName.includes('MOBILE ALERTS') ||
            sensorName.includes('Sensorübersicht')) {
          return;
        }

        // Finde den nächsten Container mit Sensordaten (Tabelle oder div)
        let $dataContainer = $h4.next();
        while ($dataContainer.length && 
               !$dataContainer.is('table') && 
               !$dataContainer.is('.table') && 
               !$dataContainer.is('.panel') && 
               !$dataContainer.is('.well') &&
               $dataContainer.text().trim().length < 50) {
          $dataContainer = $dataContainer.next();
        }

        // Wenn kein Container gefunden, suche im nächsten table oder div
        if (!$dataContainer.is('table') && !$dataContainer.is('.table') && !$dataContainer.is('.panel')) {
          $dataContainer = $h4.nextAll('table, .table, .panel, .well').first();
        }

        const containerText = $dataContainer.text().trim().replace(/\s+/g, ' ') || $h4.parent().text().trim().replace(/\s+/g, ' ');

        // Sensor-ID extrahieren
        const idMatch = containerText.match(/ID\s+([A-F0-9]+)/i);
        const sensorId = idMatch ? idMatch[1] : null;
        
        // Zeitstempel extrahieren
        const timeMatch = containerText.match(/Zeitpunkt\s+([\d.:\s]+\d{4})/i);
        const timestamp = timeMatch ? timeMatch[1].trim() : null;
        
        // Batteriestatus
        let battery = 'ok';
        if (/batterie\s*(schwach|low|leer|empty)/i.test(containerText)) battery = 'low';

        const sensorData = {
          id: sensorId,
          timestamp: timestamp,
          battery: battery
        };

        // 🔧 EXTRAHIERE ALLE DATEN FÜR DIESEN SENSOR
        // Temperatur
        if (containerText.includes('Temperatur')) {
          const tempMatches = containerText.match(/(?:Temperatur|Temp)[\s:]*(?:Innen|In|Außen|Aus|Aussen|Kabel)?[\s:]*([-\d,]+)\s*°?C/gi);
          if (tempMatches) {
            for (const match of tempMatches) {
              const value = parseFloat(match.replace(/[^\d,.-]/g, '').replace(',', '.'));
              if (!isNaN(value)) {
                const context = match.toLowerCase();
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
          }
        }

        // Luftfeuchte
        if (containerText.includes('Luftfeuchte') || containerText.includes('Hum')) {
          const humMatches = containerText.match(/(?:Luftfeuchte|Hum|Feuchte)[\s:]*(?:Innen|In|Außen|Aus|Aussen)?[\s:]*([\d,]+)\s*%/gi);
          if (humMatches) {
            for (const match of humMatches) {
              const value = parseFloat(match.replace(/[^\d,.-]/g, '').replace(',', '.'));
              if (!isNaN(value)) {
                const context = match.toLowerCase();
                if (context.includes('außen') || context.includes('aussen') || context.includes('aus')) {
                  sensorData.humidity_out = value;
                } else if (context.includes('innen') || context.includes('in')) {
                  sensorData.humidity_in = value;
                } else {
                  sensorData.humidity = value;
                }
              }
            }
          }
        }

        // Regen
        const rainTotalMatch = containerText.match(/(?:Regen[\s:]*(?:Gesamt|Total)?|Gesamt[\s:]*Regen)[\s:]*([\d,]+)\s*mm/i);
        if (rainTotalMatch) {
          sensorData.rain_total = parseFloat(rainTotalMatch[1].replace(',', '.'));
        }
        
        const rainRateMatch = containerText.match(/Rate[\s:]*([\d,]+)\s*mm\/h/i);
        if (rainRateMatch) {
          sensorData.rain_rate = parseFloat(rainRateMatch[1].replace(',', '.'));
        }
        
        // Wind
        const windSpeedMatch = containerText.match(/Windgeschwindigkeit[\s:]*([\d,]+)\s*m\/s/i);
        if (windSpeedMatch) {
          sensorData.wind_speed = this.convertWind(parseFloat(windSpeedMatch[1].replace(',', '.')));
        }
        
        const windGustMatch = containerText.match(/Böe[\s:]*([\d,]+)\s*m\/s/i);
        if (windGustMatch) {
          sensorData.wind_gust = this.convertWind(parseFloat(windGustMatch[1].replace(',', '.')));
        }
        
        const windDirMatch = containerText.match(/Windrichtung[\s:]*([A-Za-zäöüß]+|\d{1,3}°)/i);
        if (windDirMatch) {
          sensorData.wind_dir = windDirMatch[1];
        }
        
        // Feuchtesensor (trocken/feucht)
        if (containerText.includes('Feuchtesensor') || containerText.includes('Bodenfeuchte')) {
          const wetMatch = containerText.match(/(trocken|feucht)/i);
          if (wetMatch) {
            sensorData.wet = wetMatch[1].toLowerCase() === 'feucht';
          }
        }
        
        // Kontaktsensor
        if (containerText.includes('Kontaktsensor')) {
          if (containerText.includes('Geschlossen')) {
            sensorData.contact = 'closed';
          } else if (containerText.includes('Offen') || containerText.includes('Open')) {
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

      // 🔄 FALLBACK FÜR ALTE STRUKTUR (wenn keine H4 gefunden)
      if (!sensors.length) {
        this.log.info(`Keine H4-Sensoren gefunden, verwende alte Struktur für Phone_${phoneId}`);
        
        $('div.sensor, table.table, div.panel, div.well').each((i, el) => {
          const $el = $(el);
          const text = $el.text().trim().replace(/\s+/g, ' ');
          
          if (text && text.length > 50) {
            const nameMatch = text.match(/^(.*?)(?=\s+(ID|Zeitpunkt|Temp|Hum|Temperatur|Luftfeuchte))/i);
            const sensorName = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
            
            const sensorData = {};
            
            // Extrahiere Daten wie oben
            const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
            if (idMatch) sensorData.id = idMatch[1];
            
            const timeMatch = text.match(/Zeitpunkt\s+([\d.:\s]+\d{4})/i);
            if (timeMatch) sensorData.timestamp = timeMatch[1].trim();
            
            let battery = 'ok';
            if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';
            sensorData.battery = battery;
            
            // Extrahiere weitere Daten...
            // (Hier dieselbe Extraktionslogik wie oben einfügen)
            
            sensors.push({
              name: sensorName,
              ...sensorData
            });
          }
        });
      }

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für Phone_${phoneId}`);
        return;
      }

      // 💾 Objekte erstellen mit der ursprünglichen Struktur
      for (const sensor of sensors) {
        // Sensornamen bereinigen, aber Leerzeichen durch Unterstriche ersetzen
        const cleanSensorName = sensor.name
          .replace(/[<>:"/\\|?*]/g, '') // Ungültige Zeichen entfernen
          .trim();
        
        const base = `Phone_${phoneId}.${cleanSensorName.replace(/\s+/g, '_')}`;

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

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für Phone_${phoneId}: ${sensors.map(s => s.name).join(', ')}`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für Phone_${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
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
