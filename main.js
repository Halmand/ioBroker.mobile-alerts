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

  async fetchData(phoneId) {
    try {
      const url = `https://measurements.mobile-alerts.eu/Home/SensorsOverview?phoneId=${phoneId}`;
      const res = await axios.get(url, { timeout: 15000 });
      const html = res.data;
      const $ = cheerio.load(html);

      const sensors = [];

      // 🔍 ERKENNUNG DER SEITENSTRUKTUR
      // 1. Kompakte Struktur (wie bei 035886772208 - "Küche")
      if ($('strong:contains("Durchschn. Luftf. 3H")').length > 0) {
        this.parseCompactStructure($, sensors, phoneId);
      }
      // 2. Basis-Struktur mit nummerierten Sensoren (wie bei 296842788104)
      else if ($('div.sensor, table.table').length > 0) {
        this.parseBasisStructure($, sensors, phoneId);
      }
      // 3. H4-Struktur (für andere PhoneIDs)
      else if ($('h4:contains("ID")').length > 0) {
        this.parseH4Structure($, sensors, phoneId);
      }
      // 4. Fallback für alle anderen Fälle
      else {
        $('div.sensor, table.table, div.panel, div.well').each((i, el) => {
          const text = $(el).text().trim().replace(/\s+/g, ' ');
          if (text && text.length > 20) {
            this.parseSensorText(text, sensors, i, phoneId);
          }
        });
      }

      if (!sensors.length) {
        this.log.warn(`Keine Sensoren gefunden für Phone_${phoneId}`);
        return;
      }

      // 💾 Objekte unter Phone_PhoneID > Sensorname
      for (const sensor of sensors) {
        const base = `Phone_${phoneId}.${sensor.name.replace(/\s+/g, '_')}`;

        await this.setObjectNotExistsAsync(base, {
          type: 'channel',
          common: { name: sensor.name },
          native: { phoneId, sensorId: sensor.id },
        });

        for (const [key, val] of Object.entries(sensor)) {
          if (['name'].includes(key)) continue;

          await this.setObjectNotExistsAsync(`${base}.${key}`, {
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

          await this.setStateAsync(`${base}.${key}`, { val, ack: true });
        }
      }

      this.log.info(`Erfolgreich ${sensors.length} Sensor(en) aktualisiert für Phone_${phoneId}.`);
      await this.setStateAsync('info.connection', { val: true, ack: true });
    } catch (err) {
      this.log.error(`Fehler beim Abruf für Phone_${phoneId}: ${err.message}`);
      await this.setStateAsync('info.connection', { val: false, ack: true });
    }
  }

  // 🔧 NEUE METHODE: Für Basis-Station mit nummerierten Sensoren
  parseBasisStructure($, sensors, phoneId) {
    $('div.sensor, table.table').each((i, el) => {
      const $el = $(el);
      const text = $el.text().trim().replace(/\s+/g, ' ');
      if (!text) return;

      const nameMatch = text.match(/^(.*?) ID /);
      const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
      const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+)/);
      const id = idMatch ? idMatch[1] : null;
      const timestamp = timeMatch ? timeMatch[1].trim() : null;

      let battery = 'ok';
      if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

      const name = nameMatch ? nameMatch[1].trim() : `Sensor_${i + 1}`;
      const data = { id, timestamp, battery };

      // 🌡️ Temperatur & Feuchte - NEUE LOGIK FÜR NUMMERIERTE SENSOREN
      // Erkenne nummerierte Sensoren: "Temp 1", "Hum 1", etc.
      const tempHumRegex = /(Temp|Hum)\s+(\d+)\s+([\d,.-]+)\s*(C|%)/gi;
      let match;
      
      while ((match = tempHumRegex.exec(text)) !== null) {
        const type = match[1].toLowerCase(); // "temp" oder "hum"
        const num = match[2]; // "1", "2", "3", "4"
        const value = parseFloat(match[3].replace(',', '.'));
        
        if (type === 'temp') {
          data[`temperature_${num}`] = value;
        } else if (type === 'hum') {
          data[`humidity_${num}`] = value;
        }
      }
      
      // 🔧 MINIMALER FIX: Erkenne "Temp In" und "Temp Out" für Basis-Station
      const tempIn = text.match(/(?:Temp|Temperatur)(?:\s+In(?:nen)?)?\s+([\d,.-]+)\s*C/i);
      const humIn = text.match(/(?:Hum|Luftfeuchte)(?:\s+In(?:nen)?)?\s+([\d,.-]+)\s*%/i);
      const tempOut = text.match(/(?:Temp|Temperatur)(?:\s+Out|\s+Außen)?\s+([\d,.-]+)\s*C/i);
      const humOut = text.match(/(?:Hum|Luftfeuchte)(?:\s+Out|\s+Außen)?\s+([\d,.-]+)\s*%/i);
      const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

      // Nur setzen, wenn noch nicht durch nummerierte Sensoren gesetzt
      if (tempIn && !data.temperature_1) data.temperature = parseFloat(tempIn[1].replace(',', '.'));
      if (humIn && !data.humidity_1) data.humidity = parseFloat(humIn[1].replace(',', '.'));
      if (tempOut) data.temperature_out = parseFloat(tempOut[1].replace(',', '.'));
      if (humOut) data.humidity_out = parseFloat(humOut[1].replace(',', '.'));
      if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));

      // 🧾 Historische Durchschnittswerte
      const hum3h = text.match(/Durchschn\.?\s*Luftf\.?\s*3H\s+([\d,.-]+)\s*%/i);
      const hum24h = text.match(/Durchschn\.?\s*Luftf\.?\s*24H\s+([\d,.-]+)\s*%/i);
      const hum7d = text.match(/Durchschn\.?\s*Luftf\.?\s*7D\s+([\d,.-]+)\s*%/i);
      const hum30d = text.match(/Durchschn\.?\s*Luftf\.?\s*30D\s+([\d,.-]+)\s*%/i);

      if (hum3h) data.humidity_avg_3h = parseFloat(hum3h[1].replace(',', '.'));
      if (hum24h) data.humidity_avg_24h = parseFloat(hum24h[1].replace(',', '.'));
      if (hum7d) data.humidity_avg_7d = parseFloat(hum7d[1].replace(',', '.'));
      if (hum30d) data.humidity_avg_30d = parseFloat(hum30d[1].replace(',', '.'));

      // 🌧️ Regen
      const rainMatch1 = text.match(/Regen\s+([\d,.-]+)\s*mm/i);
      const rainMatch2 = text.match(/Regen\s*[:=]?\s*([\d,.-]+)\s*mm/i);
      const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
      const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
      
      if (rainTotal) data.rain_total = parseFloat(rainTotal[1].replace(',', '.'));
      if (rainRate) data.rain_rate = parseFloat(rainRate[1].replace(',', '.'));
      
      if (!data.rain_total && (rainMatch1 || rainMatch2)) {
        const rainValue = rainMatch1 ? rainMatch1[1] : rainMatch2[1];
        data.rain = parseFloat(rainValue.replace(',', '.'));
        if (!data.rain_total) data.rain_total = data.rain;
      }

      // 🌬️ Wind
      const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
      const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
      const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);
      if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
      if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
      if (windDir) data.wind_dir = windDir[1];

      // 🚪 TÜR/FENSTERKONTAKT - FIX AUS ALTEM CODE
      if (text.includes('Kontaktsensor')) {
        if (text.includes('Geschlossen')) {
          data.contact = 'closed';
        } else if (text.includes('Offen') || text.includes('Open')) {
          data.contact = 'open';
        }
      }

      sensors.push({ name, ...data });
    });
  }

  // NEUE METHODE: Für die kompakte Struktur (035886772208)
  parseCompactStructure($, sensors, phoneId) {
    const sensorData = {};
    const sensorName = "Küche";

    // 1. Extrahiere den Zeitpunkt
    const timeLabel = $('strong:contains("Zeitpunkt")');
    if (timeLabel.length) {
      const timeValue = timeLabel.nextAll('h4, h5').first().text().trim();
      if (timeValue) sensorData.timestamp = timeValue;
    }

    // 2. Extrahiere die Temperatur
    const tempLabel = $('strong:contains("Temperatur")');
    if (tempLabel.length) {
      const tempText = tempLabel.nextAll('h4, h5').first().text();
      const tempMatch = tempText.match(/([\d,]+)\s*C/);
      if (tempMatch) {
        const value = parseFloat(tempMatch[1].replace(',', '.'));
        if (!isNaN(value)) {
          sensorData.temperature = value;
        }
      }
    }

    // 3. Extrahiere die Luftfeuchte (nicht die Durchschnittswerte)
    const humLabel = $('strong:contains("Luftfeuchte")').filter((i, el) => {
      return !$(el).text().includes('Durchschn.');
    }).first();
    
    if (humLabel.length) {
      const humText = humLabel.nextAll('h4, h5').first().text();
      const humMatch = humText.match(/([\d,]+)\s*%/);
      if (humMatch) {
        const value = parseFloat(humMatch[1].replace(',', '.'));
        if (!isNaN(value)) {
          sensorData.humidity = value;
        }
      }
    }

    // 4. Extrahiere die historischen Durchschnittswerte
    const avgLabels = ['3H', '24H', '7D', '30D'];
    avgLabels.forEach(period => {
      const labelText = `Durchschn. Luftf. ${period}`;
      const avgLabel = $(`strong:contains("${labelText}")`);
      if (avgLabel.length) {
        const avgText = avgLabel.nextAll('h4, h5').first().text();
        const avgMatch = avgText.match(/([\d,.-]+)\s*%/);
        if (avgMatch) {
          const value = parseFloat(avgMatch[1].replace(',', '.'));
          if (!isNaN(value)) {
            sensorData[`humidity_avg_${period.toLowerCase()}`] = value;
          }
        }
      }
    });

    // Füge den Sensor nur hinzu, wenn wir Daten haben
    if (Object.keys(sensorData).length > 0) {
      sensors.push({ name: sensorName, ...sensorData });
      this.log.info(`Kompakte Struktur für Phone_${phoneId} erkannt und geparst.`);
    }
  }

  parseH4Structure($, sensors, phoneId) {
    let currentSensor = null;
    let sensorIndex = 0;

    $('body > *').each((i, el) => {
      const $el = $(el);
      const tagName = $el.prop('tagName');
      const text = $el.text().trim();

      if (tagName === 'H4' && text && !text.includes('Phone ID') && !text.includes('Überblick') && !text.includes('MOBILE ALERTS')) {
        if (currentSensor && Object.keys(currentSensor.data).length > 0) {
          sensors.push({
            name: currentSensor.name,
            ...currentSensor.data
          });
        }
        
        currentSensor = {
          name: text.trim(),
          data: {}
        };
        sensorIndex++;
      } 
      else if (currentSensor && text) {
        if (text.startsWith('ID')) {
          const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
          if (idMatch) currentSensor.data.id = idMatch[1];
        } 
        else if (text.startsWith('Zeitpunkt')) {
          const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+\d{4})/i);
          if (timeMatch) currentSensor.data.timestamp = timeMatch[1].trim();
        }
        else if (text.match(/(Temp|Hum|Temperatur|Luftfeuchte|Regen|Wind)/i)) {
          // Verwende die vereinfachte extractSensorData
          this.extractSensorDataSimple(text, currentSensor.data);
        }
        
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text) && !currentSensor.data.battery) {
          currentSensor.data.battery = 'low';
        }

        // 🚪 TÜR/FENSTERKONTAKT - FIX AUS ALTEM CODE
        if (text.includes('Kontaktsensor')) {
          if (text.includes('Geschlossen')) {
            currentSensor.data.contact = 'closed';
          } else if (text.includes('Offen') || text.includes('Open')) {
            currentSensor.data.contact = 'open';
          }
        }
      }
    });

    if (currentSensor && Object.keys(currentSensor.data).length > 0) {
      sensors.push({
        name: currentSensor.name,
        ...currentSensor.data
      });
    }
  }

  // Vereinfachte extractSensorData für H4-Struktur
  extractSensorDataSimple(text, data) {
    // 🌡️ Temperatur & Feuchte - MINIMALER FIX
    const tempIn = text.match(/(?:Temp|Temperatur)(?:\s+In(?:nen)?)?\s+([\d,.-]+)\s*C/i);
    const humIn = text.match(/(?:Hum|Luftfeuchte)(?:\s+In(?:nen)?)?\s+([\d,.-]+)\s*%/i);
    const tempOut = text.match(/(?:Temp|Temperatur)(?:\s+Out|\s+Außen)?\s+([\d,.-]+)\s*C/i);
    const humOut = text.match(/(?:Hum|Luftfeuchte)(?:\s+Out|\s+Außen)?\s+([\d,.-]+)\s*%/i);
    const tempCable = text.match(/Temperatur Kabelsensor\s+([\d,.-]+)\s*C/i);

    if (tempIn) data.temperature = parseFloat(tempIn[1].replace(',', '.'));
    if (humIn) data.humidity = parseFloat(humIn[1].replace(',', '.'));
    if (tempOut) data.temperature_out = parseFloat(tempOut[1].replace(',', '.'));
    if (humOut) data.humidity_out = parseFloat(humOut[1].replace(',', '.'));
    if (tempCable) data.temperature_cable = parseFloat(tempCable[1].replace(',', '.'));
    
    // 🌬️ Wind
    const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
    const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
    if (windSpeed) data.wind_speed = this.convertWind(parseFloat(windSpeed[1].replace(',', '.')));
    if (windGust) data.wind_gust = this.convertWind(parseFloat(windGust[1].replace(',', '.')));
    
    // 🚪 TÜR/FENSTERKONTAKT - FIX AUS ALTEM CODE
    if (text.includes('Kontaktsensor')) {
      if (text.includes('Geschlossen')) {
        data.contact = 'closed';
      } else if (text.includes('Offen') || text.includes('Open')) {
        data.contact = 'open';
      }
    }
  }

  parseOldStructure($, sensors, phoneId) {
    $('div.sensor, table.table, div.panel').each((i, el) => {
      const $el = $(el);
      const text = $el.text().trim().replace(/\s+/g, ' ');
      
      if (text && text.length > 20) {
        this.parseSensorText(text, sensors, i, phoneId);
      }
    });
  }

  parseSensorText(text, sensors, index, phoneId) {
    const nameMatch = text.match(/^(.*?)\s+(ID|Zeitpunkt|Temp|Hum|Temperatur)/i);
    const idMatch = text.match(/ID\s+([A-F0-9]+)/i);
    const timeMatch = text.match(/Zeitpunkt\s+([\d:. ]+\d{4})/i);
    
    const id = idMatch ? idMatch[1] : null;
    const timestamp = timeMatch ? timeMatch[1].trim() : null;
    
    let sensorName = 'Sensor_' + (index + 1);
    if (nameMatch) {
      sensorName = nameMatch[1].trim();
      if (phoneId && sensorName.includes(phoneId)) {
        sensorName = sensorName.replace(phoneId, '').trim();
      }
    }

    let battery = 'ok';
    if (/batterie\s*(schwach|low|leer|empty)/i.test(text)) battery = 'low';

    const data = { id, timestamp, battery };
    this.extractSensorDataSimple(text, data);

    // 🚪 TÜR/FENSTERKONTAKT - FIX AUS ALTEM CODE
    if (text.includes('Kontaktsensor')) {
      if (text.includes('Geschlossen')) {
        data.contact = 'closed';
      } else if (text.includes('Offen') || text.includes('Open')) {
        data.contact = 'open';
      }
    }

    const hasData = Object.keys(data).some(key => 
      !['id', 'timestamp', 'battery'].includes(key) && data[key] !== null && data[key] !== undefined
    );
    
    if (hasData || id) {
      sensors.push({ name: sensorName, ...data });
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

  mapRole(k) {
    if (k.startsWith('temperature')) return 'value.temperature';
    if (k.startsWith('humidity')) return 'value.humidity';
    if (k.includes('rain') || k === 'rain_total' || k === 'rain_rate') return 'value.rain';
    if (k.includes('wind')) return 'value.wind';
    if (k.includes('battery')) return 'indicator.battery';
    if (k.includes('timestamp')) return 'value.time';
    if (k === 'wet') return 'sensor.water';
    if (k === 'contact') return 'sensor.door';
    return 'state';
  }

  mapUnit(k) {
    if (k.startsWith('temperature')) return '°C';
    if (k.startsWith('humidity')) return '%';
    if (k.includes('rain')) return 'mm';
    if (k === 'rain_rate') return 'mm/h';
    if (k.includes('wind')) {
      if (this.windUnit === 'km/h') return 'km/h';
      if (this.windUnit === 'bft') return 'Bft';
      return 'm/s';
    }
    return '';
  }

  getFriendlyName(k) {
    const names = {
      temperature: 'Temperatur',
      temperature_in: 'Temperatur Innen',
      temperature_out: 'Temperatur Außen',
      temperature_cable: 'Temperatur Kabel',
      temperature_1: 'Temperatur Sensor 1',
      temperature_2: 'Temperatur Sensor 2',
      temperature_3: 'Temperatur Sensor 3',
      temperature_4: 'Temperatur Sensor 4',
      humidity: 'Luftfeuchte',
      humidity_in: 'Luftfeuchte Innen',
      humidity_out: 'Luftfeuchte Außen',
      humidity_1: 'Luftfeuchte Sensor 1',
      humidity_2: 'Luftfeuchte Sensor 2',
      humidity_3: 'Luftfeuchte Sensor 3',
      humidity_4: 'Luftfeuchte Sensor 4',
      rain: 'Regen',
      rain_total: 'Regen Gesamt',
      rain_rate: 'Regen Rate',
      wind_speed: 'Windgeschwindigkeit',
      wind_gust: 'Windböe',
      wind_dir: 'Windrichtung',
      battery: 'Batterie',
      timestamp: 'Letzte Aktualisierung',
      wet: 'Feuchtigkeit',
      contact: 'Kontaktstatus',
      id: 'Sensor ID',
      humidity_avg_3h: 'Durchschnitt Luftfeuchte 3H',
      humidity_avg_24h: 'Durchschnitt Luftfeuchte 24H',
      humidity_avg_7d: 'Durchschnitt Luftfeuchte 7D',
      humidity_avg_30d: 'Durchschnitt Luftfeuchte 30D',
    };
    
    if (k.startsWith('temperature_') && !names[k]) {
      const num = k.replace('temperature_', '');
      return `Temperatur Sensor ${num}`;
    }
    
    if (k.startsWith('humidity_') && !names[k] && !k.includes('avg')) {
      const num = k.replace('humidity_', '');
      return `Luftfeuchte Sensor ${num}`;
    }
    
    return names[k] || k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
}

if (require.main !== module) {
  module.exports = (options) => new MobileAlerts(options);
} else {
  new MobileAlerts();
}
