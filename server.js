require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));

// Custom password authentication middleware (Basic Auth)
app.use(async (req, res, next) => {
  try {
    const password = (process.env.DASHBOARD_PASSWORD || await getConfig('dashboard_password') || '').trim();
    if (!password) {
      return next();
    }
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Unified Wealth Dashboard"');
      return res.sendStatus(401);
    }
    const parts = authHeader.split(' ');
    if (parts[0] !== 'Basic' || !parts[1]) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Unified Wealth Dashboard"');
      return res.sendStatus(401);
    }
    const credentials = Buffer.from(parts[1], 'base64').toString('utf8').split(':');
    const pass = credentials.slice(1).join(':').trim();
    if (pass === password) {
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Unified Wealth Dashboard"');
    return res.sendStatus(401);
  } catch (err) {
    next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
  }
});

// Promisified DB Helpers
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// Config Helper
async function getConfig(key) {
  try {
    const row = await dbGet(`SELECT value FROM config WHERE key = ?`, [key]);
    return row ? row.value : null;
  } catch (err) {
    console.error(`Error reading config key ${key}:`, err.message);
    return null;
  }
}

// Database Initialization
async function initDb() {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS transacciones_iol (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT,
        ticker TEXT,
        operacion TEXT,
        cantidad REAL,
        precio_unitario REAL,
        comision REAL,
        unique_hash TEXT UNIQUE
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS historial_patrimonio (
        fecha TEXT UNIQUE,
        total_ars REAL,
        total_usd REAL
      )
    `);

    // Default configuration insertion
    const insertConfig = async (key, defaultValue) => {
      await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`, [key, defaultValue]);
    };

    await insertConfig('binance_api_key', '');
    await insertConfig('binance_api_secret', '');
    await insertConfig('manual_usd_balance', '0');
    await insertConfig('manual_ars_balance', '0');
    await insertConfig('interest_rate_override', '8');
    await insertConfig('dashboard_password', '');

    console.log('Database schema checked and initialized.');
  } catch (err) {
    console.error('Error during database initialization:', err.message);
  }
}

// Heuristics to check if ticker is a bond (so we scrape Rava instead of Yahoo)
function isBondTicker(ticker) {
  // Matches typical bond names like: AL30, GD30, AL30D, BPO27, AE38, etc.
  // 2 to 4 letters, followed by 2 digits, and optionally a currency letter (D/C/Y) at the end
  return /^[A-Z]{2,4}[0-9]{2}[A-Z]?$/.test(ticker.toUpperCase());
}

// Helper to sanitize numeric inputs from copy-paste
function cleanNumber(str) {
  if (!str) return 0;
  let cleaned = str.replace(/[\$\sUSD]/g, '');
  // Format check:
  // If it has dot and comma, like 1.234,56 -> remove dot, replace comma with dot
  if (cleaned.includes('.') && cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
  } 
  // If it has only comma, e.g. 64,26 -> replace comma with dot
  else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/,/g, '.');
  }
  // If it has only dot, check if it's a thousands separator:
  else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    // In Spanish formatting, a single dot like 97.840 has exactly 3 decimal digits after it
    if (parts[parts.length - 1].length === 3) {
      cleaned = cleaned.replace(/\./g, '');
    }
  }
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

// Fetch Prices
async function fetchYahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`Yahoo Finance returned status ${res.status}`);
  const data = await res.json();
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No metadata found for ${symbol} in Yahoo Finance`);
  return meta.regularMarketPrice || 0;
}

async function fetchRavaPrice(ticker) {
  const url = `https://www.rava.com/perfil/${ticker}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`Rava returned status ${res.status}`);
  const html = await res.text();
  
  // Scrapes Rava's og:description tag: e.g. <meta property="og:description" content="$97.840 (+0,30%)...">
  const match = html.match(/<meta\s+property="og:description"\s+content="\$([0-9.,]+)/i);
  if (!match) throw new Error(`Could not find price in Rava og:description for ${ticker}`);
  
  return cleanNumber(match[1]);
}

async function fetchMarketPrice(ticker) {
  ticker = ticker.toUpperCase().trim();
  if (isBondTicker(ticker)) {
    try {
      return await fetchRavaPrice(ticker);
    } catch (err) {
      console.warn(`Rava failed for bond ${ticker}, falling back to Yahoo Finance:`, err.message);
      try {
        return await fetchYahooPrice(ticker + '.BA');
      } catch (e) {
        return 0;
      }
    }
  } else {
    try {
      const symbol = ticker.includes('.') ? ticker : ticker + '.BA';
      return await fetchYahooPrice(symbol);
    } catch (err) {
      console.warn(`Yahoo failed for stock/CEDEAR ${ticker}, falling back to Rava:`, err.message);
      try {
        return await fetchRavaPrice(ticker);
      } catch (e) {
        return 0;
      }
    }
  }
}

// Fetch dollar cripto (USDT/ARS ask rate)
async function fetchDolarCripto() {
  try {
    const res = await fetch('https://criptoya.com/api/dolar', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) throw new Error(`CryptoYa returned status ${res.status}`);
    const data = await res.json();
    return data.cripto?.usdt?.ask || 1500;
  } catch (err) {
    console.error('Error fetching dollar cripto:', err.message);
    return 1500;
  }
}

// Binance Server Time Synchronization
async function getBinanceTimestamp() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/time');
    const data = await res.json();
    return data.serverTime;
  } catch (e) {
    return Date.now();
  }
}

// Fetch Binance balances (Spot + Funding Wallet)
async function fetchBinanceBalances(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) return [];
  try {
    const timestamp = await getBinanceTimestamp();
    const recvWindow = 5000;
    
    // Query Spot Balance
    const spotQuery = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
    const spotSignature = crypto.createHmac('sha256', apiSecret).update(spotQuery).digest('hex');
    const spotUrl = `https://api.binance.com/api/v3/account?${spotQuery}&signature=${spotSignature}`;
    
    const spotRes = await fetch(spotUrl, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    
    let spotAssets = [];
    if (spotRes.ok) {
      const spotData = await spotRes.json();
      spotAssets = (spotData.balances || [])
        .map(b => ({
          asset: b.asset,
          free: parseFloat(b.free || 0),
          locked: parseFloat(b.locked || 0)
        }))
        .filter(b => b.free + b.locked > 0.00001);
    } else {
      const errText = await spotRes.text();
      console.error('Binance Spot API error:', spotRes.status, errText);
    }

    // Query Funding Wallet Balance
    const fundingQuery = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
    const fundingSignature = crypto.createHmac('sha256', apiSecret).update(fundingQuery).digest('hex');
    const fundingUrl = `https://api.binance.com/sapi/v1/asset/get-funding-asset`;
    
    const fundingRes = await fetch(fundingUrl, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `${fundingQuery}&signature=${fundingSignature}`
    });
    
    let fundingAssets = [];
    if (fundingRes.ok) {
      const fundingData = await fundingRes.json();
      fundingAssets = (fundingData || [])
        .map(b => ({
          asset: b.asset,
          free: parseFloat(b.free || 0),
          locked: parseFloat(b.locked || 0) + parseFloat(b.freeze || 0) + parseFloat(b.withdrawing || 0)
        }))
        .filter(b => b.free + b.locked > 0.00001);
    } else {
      const errText = await fundingRes.text();
      console.error('Binance Funding API error:', fundingRes.status, errText);
    }

    // Merge balances
    const balanceMap = {};
    const addAsset = (item) => {
      const total = item.free + item.locked;
      if (!balanceMap[item.asset]) balanceMap[item.asset] = 0;
      balanceMap[item.asset] += total;
    };
    
    spotAssets.forEach(addAsset);
    fundingAssets.forEach(addAsset);

    return Object.keys(balanceMap)
      .map(asset => ({ asset, balance: balanceMap[asset] }))
      .filter(b => b.balance > 0.00001);
  } catch (err) {
    console.error('Error in fetchBinanceBalances:', err.message);
    return [];
  }
}

// Fetch all Crypto USD Price Tickers from Binance
async function fetchCryptoPricesInUSD() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price');
    if (!res.ok) throw new Error(`Binance price ticker returned ${res.status}`);
    const data = await res.json();
    const prices = new Map();
    data.forEach(item => {
      prices.set(item.symbol, parseFloat(item.price));
    });
    return prices;
  } catch (err) {
    console.error('Error fetching crypto prices:', err.message);
    return new Map();
  }
}

function getCryptoUSDPrice(asset, pricesMap) {
  asset = asset.toUpperCase();
  if (['USDT', 'USDC', 'BUSD', 'DAI', 'USD'].includes(asset)) return 1.0;
  
  const symbol = asset + 'USDT';
  if (pricesMap.has(symbol)) return pricesMap.get(symbol);
  
  const usdcSymbol = asset + 'USDC';
  if (pricesMap.has(usdcSymbol)) return pricesMap.get(usdcSymbol);
  
  return 0;
}

// Parser for pasted IOL text
function parseIOLPaste(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  // Parse headers from first line
  const firstLineCells = lines[0].split('\t').map(c => c.trim().toLowerCase());

  let colIndex = {
    fecha: -1,
    ticker: -1,
    operacion: -1,
    cantidad: -1,
    precio: -1,
    comision: -1
  };

  const hasHeader = firstLineCells.some(cell =>
    cell.includes('fecha') || cell.includes('ticker') || cell.includes('especie') || 
    cell.includes('símbolo') || cell.includes('simbolo') || cell.includes('operación') || 
    cell.includes('operacion') || cell.includes('tipo') || cell.includes('cantidad')
  );

  let dataLines = lines;
  if (hasHeader) {
    dataLines = lines.slice(1);
    firstLineCells.forEach((cell, idx) => {
      if (cell.includes('fecha')) colIndex.fecha = idx;
      else if (cell.includes('ticker') || cell.includes('símbolo') || cell.includes('simbolo') || cell.includes('especie') || cell.includes('activo')) colIndex.ticker = idx;
      else if (cell.includes('operación') || cell.includes('operacion') || cell.includes('tipo') || cell.includes('movimiento') || cell.includes('acción')) {
        colIndex.operacion = idx;
      }
      else if (cell.includes('cantidad') || cell.includes('nominales')) colIndex.cantidad = idx;
      else if (cell.includes('precio') || cell.includes('valor') || cell.includes('cotización') || cell.includes('cotizacion')) {
        if (cell.includes('unitario') || colIndex.precio === -1) {
          colIndex.precio = idx;
        }
      }
      else if (cell.includes('comisión') || cell.includes('comision') || cell.includes('arancel') || cell.includes('gastos') || cell.includes('derechos')) {
        colIndex.comision = idx;
      }
    });
  }

  const transactions = [];

  for (let i = 0; i < dataLines.length; i++) {
    const rawLine = dataLines[i];
    const cells = rawLine.split('\t').map(c => c.trim());
    if (cells.length < 3) continue;

    let fecha = '';
    let ticker = '';
    let operacion = '';
    let cantidad = 0;
    let precio_unitario = 0;
    let comision = 0;

    if (hasHeader) {
      if (colIndex.fecha !== -1) fecha = cells[colIndex.fecha];
      if (colIndex.ticker !== -1) ticker = cells[colIndex.ticker];
      if (colIndex.operacion !== -1) operacion = cells[colIndex.operacion];
      if (colIndex.cantidad !== -1) cantidad = cleanNumber(cells[colIndex.cantidad]);
      if (colIndex.precio !== -1) precio_unitario = cleanNumber(cells[colIndex.precio]);
      if (colIndex.comision !== -1) comision = cleanNumber(cells[colIndex.comision]);
    } else {
      // Heuristic parsing
      cells.forEach(cell => {
        if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(cell) || /^\d{4}\-\d{2}\-\d{2}$/.test(cell)) {
          fecha = cell;
        } else if (/compra/i.test(cell) || /suscripción/i.test(cell) || /suscripcion/i.test(cell)) {
          operacion = 'Compra';
        } else if (/venta/i.test(cell) || /rescate/i.test(cell)) {
          operacion = 'Venta';
        } else if (/^[A-Z0-9]{3,6}$/.test(cell) && !/^[0-9]+$/.test(cell)) {
          ticker = cell;
        }
      });

      // Secondary operation parsing
      if (!operacion) {
        cells.forEach(cell => {
          if (/egreso|débito|debito/i.test(cell)) operacion = 'Compra';
          else if (/ingreso|crédito|credito/i.test(cell)) operacion = 'Venta';
        });
      }

      // Map numeric indexes
      let dateIdx = cells.findIndex(c => /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(c) || /^\d{4}\-\d{2}\-\d{2}$/.test(c));
      let opIdx = cells.findIndex(c => /compra|venta|suscri|rescat|egreso|ingreso/i.test(c));
      let tickIdx = cells.findIndex(c => /^[A-Z0-9]{3,6}$/.test(c) && !/^[0-9]+$/.test(c));

      let numericIndices = [];
      cells.forEach((c, idx) => {
        if (idx !== dateIdx && idx !== opIdx && idx !== tickIdx) {
          const val = cleanNumber(c);
          if (!isNaN(val) && c !== '') numericIndices.push(idx);
        }
      });

      if (numericIndices.length >= 3) {
        cantidad = cleanNumber(cells[numericIndices[0]]);
        precio_unitario = cleanNumber(cells[numericIndices[1]]);
        if (numericIndices.length === 3) {
          comision = cleanNumber(cells[numericIndices[2]]);
        } else {
          comision = cleanNumber(cells[numericIndices[3]]);
        }
      }
    }

    // Standardize operation
    if (/compra|suscri|egreso|debito|débito/i.test(operacion)) {
      operacion = 'Compra';
    } else if (/venta|rescat|ingreso|credito|crédito/i.test(operacion)) {
      operacion = 'Venta';
    } else {
      continue;
    }

    // Format Date (YYYY-MM-DD)
    let formattedDate = fecha;
    if (fecha) {
      const parts = fecha.split(/[\/\-]/);
      if (parts.length === 3) {
        let day, month, year;
        if (parts[0].length === 4) {
          year = parts[0];
          month = parts[1];
          day = parts[2];
        } else {
          day = parts[0].padStart(2, '0');
          month = parts[1].padStart(2, '0');
          year = parts[2];
          if (year.length === 2) year = '20' + year;
        }
        formattedDate = `${year}-${month}-${day}`;
      }
    }

    if (formattedDate && ticker && operacion && cantidad > 0 && precio_unitario > 0) {
      const rawRowStr = `${formattedDate}_${ticker}_${operacion}_${cantidad}_${precio_unitario}_${comision}`;
      const unique_hash = crypto.createHash('md5').update(rawRowStr).digest('hex');

      transactions.push({
        fecha: formattedDate,
        ticker: ticker.toUpperCase(),
        operacion,
        cantidad,
        precio_unitario,
        comision: comision || 0,
        unique_hash
      });
    }
  }

  return transactions;
}

// Calculate IOL current holdings & PPC Real
function calculateIOLHoldings(transactions) {
  const sorted = [...transactions].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const holdings = {};

  sorted.forEach(t => {
    const ticker = t.ticker;
    if (!holdings[ticker]) {
      holdings[ticker] = { cantidad: 0, ppc: 0, total_cost: 0 };
    }

    const h = holdings[ticker];
    const isBond = isBondTicker(ticker);

    if (t.operacion === 'Compra') {
      let cost = isBond ? (t.cantidad * (t.precio_unitario / 100)) + t.comision : (t.cantidad * t.precio_unitario) + t.comision;
      h.total_cost += cost;
      h.cantidad += t.cantidad;
      if (h.cantidad > 0) {
        h.ppc = isBond ? (h.total_cost / h.cantidad) * 100 : h.total_cost / h.cantidad;
      }
    } else if (t.operacion === 'Venta') {
      h.cantidad -= t.cantidad;
      if (h.cantidad <= 0) {
        h.cantidad = 0;
        h.ppc = 0;
        h.total_cost = 0;
      } else {
        h.total_cost = isBond ? h.cantidad * (h.ppc / 100) : h.cantidad * h.ppc;
      }
    }
  });

  const activeHoldings = {};
  for (const ticker in holdings) {
    if (holdings[ticker].cantidad > 0.0001) {
      activeHoldings[ticker] = holdings[ticker];
    }
  }

  return activeHoldings;
}

// Consolidated Totals Calculator
async function calculateCurrentPortfolioTotals() {
  const manualUsd = parseFloat(await getConfig('manual_usd_balance') || '0');
  const manualArs = parseFloat(await getConfig('manual_ars_balance') || '0');
  const dollarCripto = await fetchDolarCripto();

  // 1. Traditional assets
  const transactions = await dbAll(`SELECT * FROM transacciones_iol`);
  const iolHoldings = calculateIOLHoldings(transactions);
  
  let iolTotalArs = 0;
  let iolTotalUsd = 0;

  for (const ticker in iolHoldings) {
    const h = iolHoldings[ticker];
    const price = await fetchMarketPrice(ticker);
    const isBond = isBondTicker(ticker);
    const isUsdAsset = ticker.endsWith('D');
    
    const assetValue = isBond ? h.cantidad * (price / 100) : h.cantidad * price;

    if (isUsdAsset) {
      iolTotalUsd += assetValue;
      iolTotalArs += assetValue * dollarCripto;
    } else {
      iolTotalArs += assetValue;
      iolTotalUsd += assetValue / dollarCripto;
    }
  }

  // 2. Crypto assets
  const apiKey = await getConfig('binance_api_key');
  const apiSecret = await getConfig('binance_api_secret');
  
  let cryptoTotalUsd = 0;
  let cryptoTotalArs = 0;

  if (apiKey && apiSecret) {
    const cryptoBalances = await fetchBinanceBalances(apiKey, apiSecret);
    const cryptoPrices = await fetchCryptoPricesInUSD();
    
    cryptoBalances.forEach(item => {
      const priceUsd = getCryptoUSDPrice(item.asset, cryptoPrices);
      const valUsd = item.balance * priceUsd;
      cryptoTotalUsd += valUsd;
      cryptoTotalArs += valUsd * dollarCripto;
    });
  }

  // 3. Totals
  const totalUsd = manualUsd + (manualArs / dollarCripto) + iolTotalUsd + cryptoTotalUsd;
  const totalArs = manualArs + (manualUsd * dollarCripto) + iolTotalArs + cryptoTotalArs;

  return { totalArs, totalUsd };
}

// API Routes

// Configuration
app.post('/api/config', async (req, res) => {
  const { binance_api_key, binance_api_secret, manual_usd_balance, manual_ars_balance, interest_rate_override, dashboard_password } = req.body;
  try {
    const setConfig = async (key, val) => {
      if (val !== undefined && val !== null) {
        await dbRun(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`, [key, val.toString().trim()]);
      }
    };
    await setConfig('binance_api_key', binance_api_key);
    await setConfig('binance_api_secret', binance_api_secret);
    await setConfig('manual_usd_balance', manual_usd_balance);
    await setConfig('manual_ars_balance', manual_ars_balance);
    await setConfig('interest_rate_override', interest_rate_override);
    await setConfig('dashboard_password', dashboard_password);
    res.json({ success: true, message: 'Configuración guardada correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', async (req, res) => {
  try {
    const binance_key = await getConfig('binance_api_key') || '';
    const binance_secret = await getConfig('binance_api_secret') || '';
    const manual_usd = await getConfig('manual_usd_balance') || '0';
    const manual_ars = await getConfig('manual_ars_balance') || '0';
    const interest_rate = await getConfig('interest_rate_override') || '8';
    const dashboard_pass = process.env.DASHBOARD_PASSWORD || await getConfig('dashboard_password') || '';

    const mask = (str) => {
      if (!str) return '';
      if (str.length <= 8) return '********';
      return str.slice(0, 4) + '...' + str.slice(-4);
    };

    res.json({
      binance_api_key_set: binance_key !== '',
      binance_api_key_masked: mask(binance_key),
      binance_api_secret_set: binance_secret !== '',
      binance_api_secret_masked: mask(binance_secret),
      manual_usd_balance: parseFloat(manual_usd),
      manual_ars_balance: parseFloat(manual_ars),
      interest_rate_override: parseFloat(interest_rate),
      dashboard_password_set: dashboard_pass !== '',
      dashboard_password_masked: mask(dashboard_pass)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload IOL Text
app.post('/api/upload-iol', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'No se envió texto para procesar.' });
  }
  try {
    const transactions = parseIOLPaste(text);
    if (transactions.length === 0) {
      return res.json({ success: true, count: 0, message: 'No se encontraron transacciones válidas.' });
    }

    let insertedCount = 0;
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO transacciones_iol (fecha, ticker, operacion, cantidad, precio_unitario, comision, unique_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const runStmt = (t) => new Promise((resolve, reject) => {
      stmt.run([t.fecha, t.ticker, t.operacion, t.cantidad, t.precio_unitario, t.comision, t.unique_hash], function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });

    for (const t of transactions) {
      const changes = await runStmt(t);
      insertedCount += changes;
    }

    res.json({
      success: true,
      count: insertedCount,
      parsedCount: transactions.length,
      message: `Se procesaron ${transactions.length} filas. Se insertaron ${insertedCount} nuevas transacciones.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset IOL Data
app.post('/api/reset-iol', async (req, res) => {
  try {
    await dbRun(`DELETE FROM transacciones_iol`);
    res.json({ success: true, message: 'Historial de transacciones de IOL eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset History Data
app.post('/api/reset-history', async (req, res) => {
  try {
    await dbRun(`DELETE FROM historial_patrimonio`);
    res.json({ success: true, message: 'Historial de evolución patrimonial eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main Portfolio Data
app.get('/api/portfolio', async (req, res) => {
  try {
    const manualUsd = parseFloat(await getConfig('manual_usd_balance') || '0');
    const manualArs = parseFloat(await getConfig('manual_ars_balance') || '0');
    const dollarCripto = await fetchDolarCripto();

    // 1. Traditional Assets (IOL)
    const transactions = await dbAll(`SELECT * FROM transacciones_iol`);
    const iolHoldingsMap = calculateIOLHoldings(transactions);
    
    const traditionalAssets = [];
    let iolTotalCostArs = 0;
    let iolTotalValueArs = 0;
    let iolTotalCostUsd = 0;
    let iolTotalValueUsd = 0;

    const tickers = Object.keys(iolHoldingsMap);
    const pricePromises = tickers.map(ticker => fetchMarketPrice(ticker));
    const prices = await Promise.all(pricePromises);
    
    tickers.forEach((ticker, index) => {
      const h = iolHoldingsMap[ticker];
      const price = prices[index] || 0;
      const isBond = isBondTicker(ticker);
      const isUsdAsset = ticker.toUpperCase().endsWith('D');

      const totalCost = isBond ? h.cantidad * (h.ppc / 100) : h.cantidad * h.ppc;
      const currentValue = isBond ? h.cantidad * (price / 100) : h.cantidad * price;

      let costArs = 0, costUsd = 0, valArs = 0, valUsd = 0;

      if (isUsdAsset) {
        costUsd = totalCost;
        costArs = totalCost * dollarCripto;
        valUsd = currentValue;
        valArs = currentValue * dollarCripto;
      } else {
        costArs = totalCost;
        costUsd = totalCost / dollarCripto;
        valArs = currentValue;
        valUsd = currentValue / dollarCripto;
      }

      iolTotalCostArs += costArs;
      iolTotalValueArs += valArs;
      iolTotalCostUsd += costUsd;
      iolTotalValueUsd += valUsd;

      const gainArs = valArs - costArs;
      const gainPct = costArs > 0 ? (gainArs / costArs) * 100 : 0;

      traditionalAssets.push({
        ticker,
        cantidad: h.cantidad,
        ppc: h.ppc,
        precio_actual: price,
        costo_total_ars: costArs,
        costo_total_usd: costUsd,
        valor_actual_ars: valArs,
        valor_actual_usd: valUsd,
        ganancia_ars: gainArs,
        ganancia_pct: gainPct,
        isBond,
        isUsdAsset
      });
    });

    // 2. Crypto Assets (Binance)
    const apiKey = await getConfig('binance_api_key');
    const apiSecret = await getConfig('binance_api_secret');
    
    const cryptoAssets = [];
    let cryptoTotalValueUsd = 0;
    let cryptoTotalValueArs = 0;

    if (apiKey && apiSecret) {
      const cryptoBalances = await fetchBinanceBalances(apiKey, apiSecret);
      const cryptoPrices = await fetchCryptoPricesInUSD();
      
      cryptoBalances.forEach(item => {
        const priceUsd = getCryptoUSDPrice(item.asset, cryptoPrices);
        const valUsd = item.balance * priceUsd;
        const valArs = valUsd * dollarCripto;

        cryptoTotalValueUsd += valUsd;
        cryptoTotalValueArs += valArs;

        // Only list assets with a value of at least $1.00 USD
        if (valUsd >= 1.00) {
          cryptoAssets.push({
            asset: item.asset,
            balance: item.balance,
            precio_usd: priceUsd,
            precio_ars: priceUsd * dollarCripto,
            valor_usd: valUsd,
            valor_ars: valArs
          });
        }
      });
    }

    // 3. Consolidation
    const totalValueUsd = manualUsd + (manualArs / dollarCripto) + iolTotalValueUsd + cryptoTotalValueUsd;
    const totalValueArs = manualArs + (manualUsd * dollarCripto) + iolTotalValueArs + cryptoTotalValueArs;

    // Crypto assets count cost basis equal to value since we don't track historical crypto trades
    const totalCostUsd = manualUsd + (manualArs / dollarCripto) + iolTotalCostUsd + cryptoTotalValueUsd;
    const totalCostArs = manualArs + (manualUsd * dollarCripto) + iolTotalCostArs + cryptoTotalValueArs;

    const globalGainUsd = totalValueUsd - totalCostUsd;
    const globalGainArs = totalValueArs - totalCostArs;
    const globalGainPct = totalCostUsd > 0 ? (globalGainUsd / totalCostUsd) * 100 : 0;

    res.json({
      dollar_cripto: dollarCripto,
      manual_balances: {
        usd: manualUsd,
        ars: manualArs
      },
      traditional: {
        assets: traditionalAssets,
        total_cost_ars: iolTotalCostArs,
        total_value_ars: iolTotalValueArs,
        total_cost_usd: iolTotalCostUsd,
        total_value_usd: iolTotalValueUsd
      },
      crypto: {
        assets: cryptoAssets,
        total_value_usd: cryptoTotalValueUsd,
        total_value_ars: cryptoTotalValueArs
      },
      consolidated: {
        total_usd: totalValueUsd,
        total_ars: totalValueArs,
        total_cost_usd: totalCostUsd,
        total_cost_ars: totalCostArs,
        gain_usd: globalGainUsd,
        gain_ars: globalGainArs,
        gain_pct: globalGainPct
      }
    });

  } catch (err) {
    console.error('Error creating portfolio analysis:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Historical wealth evolution
app.get('/api/historial', async (req, res) => {
  try {
    const history = await dbAll(`SELECT * FROM historial_patrimonio ORDER BY fecha ASC`);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual Cron Trigger
app.post('/api/cron-trigger', async (req, res) => {
  try {
    console.log('Manual consolidation triggered.');
    const totals = await calculateCurrentPortfolioTotals();
    const today = new Date().toISOString().split('T')[0];
    await dbRun(
      `INSERT INTO historial_patrimonio (fecha, total_ars, total_usd)
       VALUES (?, ?, ?)
       ON CONFLICT(fecha) DO UPDATE SET total_ars = excluded.total_ars, total_usd = excluded.total_usd`,
      [today, totals.totalArs, totals.totalUsd]
    );
    res.json({
      success: true,
      fecha: today,
      total_ars: totals.totalArs,
      total_usd: totals.totalUsd,
      message: 'Consolidación guardada correctamente.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Price Test Tool
app.get('/api/test-fetch', async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'Ticker query param is required' });
  try {
    const price = await fetchMarketPrice(ticker);
    const isBond = isBondTicker(ticker);
    res.json({ ticker, price, isBond });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cron setup: at 18:00hs every day
cron.schedule('0 18 * * *', async () => {
  console.log('Executing automated daily wealth consolidation...');
  try {
    const totals = await calculateCurrentPortfolioTotals();
    const today = new Date().toISOString().split('T')[0];
    await dbRun(
      `INSERT INTO historial_patrimonio (fecha, total_ars, total_usd)
       VALUES (?, ?, ?)
       ON CONFLICT(fecha) DO UPDATE SET total_ars = excluded.total_ars, total_usd = excluded.total_usd`,
      [today, totals.totalArs, totals.totalUsd]
    );
    console.log(`Cron consolidator saved for ${today}`);
  } catch (err) {
    console.error('Error in daily consolidation cron:', err.message);
  }
});

// Server Initialization
async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` Unified Wealth Dashboard running on port ${PORT}`);
    console.log(` Local web access: http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}

startServer();
