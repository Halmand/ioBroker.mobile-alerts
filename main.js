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

      // 🔍 PRÜFUNG FÜR DIE NEUE, KOMPAKTE STRUKTUR (wie bei 035886772208)
      // Diese Struktur hat keine H4-Sensoren, sondern nur eine Liste mit Werten
      if ($('strong:contains("Durchschn. Luftf. 3H")').length > 0) {
        // NEUE METHODE: Kompakte Struktur für PhoneIDs wie 035886772208
        this.parseCompactStructure($, sensors, phoneId);
      }
      // ALTE STRUKTUREN
      else {
        // Methode 1: Neue Struktur mit H4 Überschriften (für andere PhoneIDs)
        const hasH4Sensors = $('h4:contains("ID")').length > 0 || $('h4').filter((i, el) => {
          const text = $(el).text().trim();
          return text && !text.includes('Phone ID') && !text.includes('Überblick') && !text.includes('MOBILE ALERTS');
        }).length > 0;

        if (hasH4Sensors) {
          // Parse neue H4-basierte Struktur
          this.parseH4Structure($, sensors, phoneId);
        } else {
          // Methode 2: Alte Struktur mit div.sensor/table.table
          this.parseOldStructure($, sensors, phoneId);
        }

        // Methode 3: Fallback für alle Fälle
        if (!sensors.length) {
          $('div.sensor, table.table, div.panel, div.well').each((i, el) => {
            const text = $(el).text().trim().replace(/\s+/g, ' ');
            if (text && text.length > 20) {
              this.parseSensorText(text, sensors, i, phoneId);
            }
          });
        }
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

  // NEUE METHODE: Für die kompakte Struktur (035886772208)
  parseCompactStructure($, sensors, phoneId) {
    const sensorData = {};
    // Sensorname - kann hier angepasst werden oder aus der Konfiguration kommen
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
          // Speichere als temperature (nicht temperature_in oder temperature_out)
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
          this.extractSensorData(text, currentSensor.data);
        }
        
        if (/batterie\s*(schwach|low|leer|empty)/i.test(text) && !currentSensor.data.battery) {
          currentSensor.data.battery = 'low';
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
    this.extractSensorData(text, data);

    const hasData = Object.keys(data).some(key => 
      !['id', 'timestamp', 'battery'].includes(key) && data[key] !== null && data[key] !== undefined
    );
    
    if (hasData || id) {
      sensors.push({ name: sensorName, ...data });
    }
  }

  extractSensorData(text, data) {
    const multiPattern = /(Temp|Hum)\s+(\w+)\s+([-\d,]+)\s*(C|%)/gi;
    let match;
    
    while ((match = multiPattern.exec(text)) !== null) {
      const type = match[1].toLowerCase();
      const sensorLabel = match[2].toLowerCase();
      const value = parseFloat(match[3].replace(',', '.'));
      
      if (isNaN(value)) continue;
      
      if (type === 'temp') {
        if (sensorLabel === 'in' || sensorLabel === 'innen') {
          data.temperature_in = value;
        } else if (sensorLabel === 'out' || sensorLabel === 'außen' || sensorLabel === 'aussen') {
          data.temperature_out = value;
        } else if (!isNaN(sensorLabel)) {
          data[`temperature_${sensorLabel}`] = value;
        } else {
          data[`temperature_${sensorLabel}`] = value;
        }
      } else if (type === 'hum') {
        if (sensorLabel === 'in' || sensorLabel === 'innen') {
          data.humidity_in = value;
        } else if (sensorLabel === 'out' || sensorLabel === 'außen' || sensorLabel === 'aussen') {
          data.humidity_out = value;
        } else if (!isNaN(sensorLabel)) {
          data[`humidity_${sensorLabel}`] = value;
        } else {
          data[`humidity_${sensorLabel}`] = value;
        }
      }
    }
    
    const simpleTempMatch = text.match(/Temperatur\s+([-\d,]+)\s*C/i);
    if (simpleTempMatch && !data.temperature && !data.temperature_in) {
      const value = parseFloat(simpleTempMatch[1].replace(',', '.'));
      if (!isNaN(value)) data.temperature = value;
    }
    
    const simpleHumMatch = text.match(/Luftfeuchte\s+([\d,]+)\s*%/i);
    if (simpleHumMatch && !data.humidity && !data.humidity_in) {
      const value = parseFloat(simpleHumMatch[1].replace(',', '.'));
      if (!isNaN(value)) data.humidity = value;
    }
    
    const tempCableMatch = text.match(/Temperatur\s+Kabelsensor\s+([-\d,]+)\s*C/i);
    if (tempCableMatch) {
      const value = parseFloat(tempCableMatch[1].replace(',', '.'));
      if (!isNaN(value)) data.temperature_cable = value;
    }
    
    const tempOutMatch = text.match(/Temperatur\s+Außen\s+([-\d,]+)\s*C/i) || 
                        text.match(/Temperatur\s+Aussen\s+([\d,.-]+)\s*C/i);
    if (tempOutMatch && !data.temperature_out) {
      const value = parseFloat(tempOutMatch[1].replace(',', '.'));
      if (!isNaN(value)) data.temperature_out = value;
    }
    
    const humOutMatch = text.match(/Luftfeuchte\s+Außen\s+([\d,]+)\s*%/i) ||
                       text.match(/Luftfeuchte\s+Aussen\s+([\d,]+)\s*%/i);
    if (humOutMatch && !data.humidity_out) {
      const value = parseFloat(humOutMatch[1].replace(',', '.'));
      if (!isNaN(value)) data.humidity_out = value;
    }
    
    const hum3h = text.match(/Durchschn\.?\s*Luftf\.?\s*3H\s+([\d,.-]+)\s*%/i);
    const hum24h = text.match(/Durchschn\.?\s*Luftf\.?\s*24H\s+([\d,.-]+)\s*%/i);
    const hum7d = text.match(/Durchschn\.?\s*Luftf\.?\s*7D\s+([\d,.-]+)\s*%/i);
    const hum30d = text.match(/Durchschn\.?\s*Luftf\.?\s*30D\s+([\d,.-]+)\s*%/i);

    if (hum3h) {
      const value = parseFloat(hum3h[1].replace(',', '.'));
      if (!isNaN(value)) data.humidity_avg_3h = value;
    }
    if (hum24h) {
      const value = parseFloat(hum24h[1].replace(',', '.'));
      if (!isNaN(value)) data.humidity_avg_24h = value;
    }
    if (hum7d) {
      const value = parseFloat(hum7d[1].replace(',', '.'));
      if (!isNaN(value)) data.humidity_avg_7d = value;
    }
    if (hum30d) {
      const value = parseFloat(hum30d[1].replace(',', '.'));
      if (!isNaN(value)) data.humidity_avg_30d = value;
    }
    
    if (text.includes('Kontaktsensor')) {
      if (text.includes('Geschlossen')) {
        data.contact = 'closed';
      } else if (text.includes('Offen') || text.includes('Open')) {
        data.contact = 'open';
      }
    }
    
    const isMoistureSensor = text.match(/Feuchtesensor|wet|trocken|feucht/i) && 
                             !text.includes('Temperatur') && 
                             !text.includes('Luftfeuchte');
    
    if (isMoistureSensor) {
      const wetMatch = text.match(/(trocken|feucht)/i);
      if (wetMatch) data.wet = wetMatch[1].toLowerCase() === 'feucht';
    }
    
    if (text.includes('Regen')) {
      const rainMatch1 = text.match(/Regen\s+([\d,.-]+)\s*mm/i);
      const rainMatch2 = text.match(/Regen\s*[:=]?\s*([\d,.-]+)\s*mm/i);
      const rainTotal = text.match(/Gesamt\s+([\d,.-]+)\s*mm/i);
      const rainRate = text.match(/Rate\s+([\d,.-]+)\s*mm\/h/i);
      
      if (rainTotal) {
        const value = parseFloat(rainTotal[1].replace(',', '.'));
        if (!isNaN(value)) data.rain_total = value;
      }
      if (rainRate) {
        const value = parseFloat(rainRate[1].replace(',', '.'));
        if (!isNaN(value)) data.rain_rate = value;
      }
      
      if (!data.rain_total && (rainMatch1 || rainMatch2)) {
        const rainValue = rainMatch1 ? rainMatch1[1] : rainMatch2[1];
        const value = parseFloat(rainValue.replace(',', '.'));
        if (!isNaN(value)) {
          data.rain = value;
          if (!data.rain_total) data.rain_total = value;
        }
      }
    }
    
    const windSpeed = text.match(/Windgeschwindigkeit\s+([\d,.-]+)\s*m\/s/i);
    const windGust = text.match(/Böe\s+([\d,.-]+)\s*m\/s/i);
    const windDir = text.match(/Windrichtung\s+([A-Za-zäöüß]+|\d{1,3}°)/i);
    
    if (windSpeed) {
      const value = parseFloat(windSpeed[1].replace(',', '.'));
      if (!isNaN(value)) data.wind_speed = this.convertWind(value);
    }
    if (windGust) {
      const value = parseFloat(windGust[1].replace(',', '.'));
      if (!isNaN(value)) data.wind_gust = this.convertWind(value);
    }
    if (windDir) data.wind_dir = windDir[1];
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
      humidity: 'Luftfeuchte',
      humidity_in: 'Luftfeuchte Innen',
      humidity_out: 'Luftfeuchte Außen',
      humidity_1: 'Luftfeuchte Sensor 1',
      humidity_2: 'Luftfeuchte Sensor 2',
      humidity_3: 'Luftfeuchte Sensor 3',
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
