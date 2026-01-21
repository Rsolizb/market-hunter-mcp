// index.js
// Komerzia Market Hunter MCP - Railway
// Busca negocios en Google Maps usando Apify
// Versión: 2.0 (Apify Integration)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de Apify
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = 'compass/crawler-google-places';

/**
 * Helper para esperar
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Normalizar teléfono (mantiene tu lógica original)
 */
const COUNTRY_DIAL_CODES = {
  Bolivia: '+591',
  'Estado Plurinacional de Bolivia': '+591',
  Paraguay: '+595',
  España: '+34',
  Mexico: '+52',
  México: '+52',
  Argentina: '+54',
  Chile: '+56',
  Peru: '+51',
  Perú: '+51',
};

function normalizePhone(phone, country) {
  if (!phone || typeof phone !== 'string') return null;

  const trimmed = phone.trim();

  // Si ya trae +, lo dejamos tal cual
  if (trimmed.startsWith('+')) return trimmed;

  const dialCode = COUNTRY_DIAL_CODES[country] || null;
  if (!dialCode) {
    return trimmed;
  }

  let clean = trimmed.replace(/^\(0\)/, '').trim();
  clean = clean.replace(/^0+/, '').trim();

  return `${dialCode} ${clean}`;
}

/**
 * Buscar lugares usando Apify Google Maps Scraper
 */
async function searchPlacesWithApify({
  category,
  city,
  country,
  maxResults = 100,
}) {
  try {
    console.log(`🔍 Buscando con Apify: ${category} en ${city}, ${country}`);

    const searchQuery = `${category} en ${city}, ${country}`;

    // Configuración optimizada para Apify
    const apifyConfig = {
      searchStringsArray: [searchQuery],
      maxCrawledPlaces: maxResults,
      maxCrawledPlacesPerSearch: maxResults,

      // País y lenguaje
      language: 'es',
      countryCode: country === 'Bolivia' ? 'BO' : 
                   country === 'Paraguay' ? 'PY' : 
                   country === 'España' ? 'ES' :
                   country === 'Mexico' || country === 'México' ? 'MX' :
                   country === 'Argentina' ? 'AR' :
                   country === 'Chile' ? 'CL' :
                   country === 'Peru' || country === 'Perú' ? 'PE' : 'BO',

      // OPTIMIZACIONES - Reducir costo
      maxReviews: 0,
      maxImages: 0,
      includeWebResults: false,
      scrapePhone: true,
      scrapeEmailFromWebsite: false,
      scrapeReviews: false,
      scrapePeopleAlsoSearch: false,
      scrapeDirections: false,
      scrapeOpeningHours: true,
    };

    // 1. Iniciar el scraper
    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      apifyConfig,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000, // 5 minutos
      }
    );

    const runId = runResponse.data.data.id;
    const datasetId = runResponse.data.data.defaultDatasetId;

    console.log(`✅ Scraper iniciado - Run ID: ${runId}`);

    // 2. Esperar resultados
    const results = await waitForApifyResults(runId, datasetId);

    console.log(`📊 Resultados: ${results.length} lugares encontrados`);

    return results;
  } catch (error) {
    console.error(`❌ Error en Apify para "${category}":`, error.message);
    return [];
  }
}

/**
 * Esperar a que Apify termine
 */
async function waitForApifyResults(runId, datasetId, maxIntentos = 120) {
  const intervalo = 3000; // 3 segundos

  for (let i = 0; i < maxIntentos; i++) {
    const statusResponse = await axios.get(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_TOKEN}`
    );

    const status = statusResponse.data.data.status;

    if (status === 'SUCCEEDED') {
      const resultsResponse = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`
      );
      return resultsResponse.data;
    }

    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Scraper ${status.toLowerCase()}`);
    }

    // Log cada 30 segundos
    if (i % 10 === 0 && i > 0) {
      console.log(`⏳ Esperando... ${i * 3}s - Estado: ${status}`);
    }

    await sleep(intervalo);
  }

  throw new Error('Timeout: Scraper tardó demasiado');
}

/**
 * Formatear resultado de Apify a formato de lead
 */
function formatApifyResultToLead(place, country) {
  const phone = normalizePhone(place.phone, country);

  return {
    name: place.title || null,
    address: place.address || null,
    rating: place.totalScore || null,
    location: place.location
      ? {
          lat: place.location.lat,
          lng: place.location.lng,
        }
      : null,
    place_id: place.placeId || null,
    phone: phone,
    website: place.website || null,
    category: place.categoryName || null,
    reviews: place.reviewsCount || 0,
    hours: place.openingHours || null,
  };
}

/**
 * Endpoint principal: ejecuta la campaña con Apify
 *
 * Body esperado:
 * {
 *   "campaignId": "uuid",
 *   "campaignName": "Nombre",
 *   "categories": ["barberías", "spas"],
 *   "city": "Asunción",
 *   "country": "Paraguay",
 *   "maxResultsPerCategory": 200
 * }
 */
app.post('/run-campaign', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      campaignId,
      campaignName,
      categories = [],
      city,
      country,
      maxResultsPerCategory = 100,
    } = req.body || {};

    // Validaciones
    if (!campaignId || !city || !country) {
      return res.status(400).json({
        error: 'Parámetros inválidos',
        details:
          'Se requieren campaignId, city y country como mínimo para ejecutar la campaña.',
      });
    }

    let categoriesArray = [];
    if (Array.isArray(categories)) {
      categoriesArray = categories;
    } else if (typeof categories === 'string' && categories.trim()) {
      categoriesArray = [categories];
    }

    if (!categoriesArray.length) {
      return res.status(400).json({
        error: 'Parámetros inválidos',
        details: "Debes enviar al menos una categoría en 'categories'.",
      });
    }

    // Validar token de Apify
    if (!APIFY_TOKEN) {
      return res.status(500).json({
        error: 'Falta APIFY_TOKEN',
        details:
          'Configura la variable de entorno APIFY_TOKEN en Railway.',
      });
    }

    console.log(`🚀 Iniciando campaña: ${campaignName || campaignId}`);
    console.log(`📍 Ubicación: ${city}, ${country}`);
    console.log(`🏷️ Categorías: ${categoriesArray.join(', ')}`);

    // 1. Buscar lugares con Apify por todas las categorías
    const allPlacesMap = new Map();

    for (const rawCategory of categoriesArray) {
      const catStr = String(rawCategory || '').trim();
      if (!catStr) continue;

      const apifyResults = await searchPlacesWithApify({
        category: catStr,
        city,
        country,
        maxResults: maxResultsPerCategory,
      });

      // Agregar al mapa (deduplicar por place_id)
      for (const place of apifyResults) {
        const placeId = place.placeId || place.place_id;
        if (!placeId) continue;
        if (!allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }

      // Pequeña pausa entre categorías
      if (categoriesArray.length > 1) {
        await sleep(2000);
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());

    console.log(`📊 Total de lugares únicos encontrados: ${allPlaces.length}`);

    // 2. Filtrar solo los que tienen teléfono
    const placesWithPhone = allPlaces.filter(
      (p) => p.phone && p.phone.trim() !== ''
    );

    console.log(`📞 Lugares con teléfono: ${placesWithPhone.length}`);

    // 3. Formatear a leads
    const leads = placesWithPhone.map((place) =>
      formatApifyResultToLead(place, country)
    );

    // 4. Calcular resumen
    const total = leads.length;
    const ratings = leads
      .map((l) => (typeof l.rating === 'number' ? l.rating : null))
      .filter((r) => r !== null);

    const avgRating =
      ratings.length > 0
        ? Number(
            (
              ratings.reduce((sum, r) => sum + r, 0) / ratings.length
            ).toFixed(2)
          )
        : 0;

    const executionTime = Date.now() - startTime;

    console.log(
      `✅ Campaña completada en ${(executionTime / 1000).toFixed(2)}s`
    );

    // 5. Respuesta
    return res.json({
      campaignId,
      campaignName,
      categories: categoriesArray,
      city,
      country,
      leads,
      executionTime,
      summary: {
        total,
        totalFound: allPlaces.length,
        withPhone: placesWithPhone.length,
        avgRating,
      },
    });
  } catch (err) {
    console.error('❌ Error en /run-campaign:', err);

    return res.status(500).json({
      error: 'Error ejecutando campaña',
      details: err.message || 'Error desconocido',
    });
  }
});

/**
 * Endpoint simple para búsqueda individual
 */
app.post('/api/search-places', async (req, res) => {
  try {
    const { query, location, maxResults } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'El campo "query" es requerido',
      });
    }

    const searchQuery = location ? `${query} ${location}` : query;

    const apifyConfig = {
      searchStringsArray: [searchQuery],
      maxCrawledPlaces: maxResults || 100,
      language: 'es',
      countryCode: 'BO',
      maxReviews: 0,
      maxImages: 0,
      includeWebResults: false,
      scrapePhone: true,
      scrapeEmailFromWebsite: false,
    };

    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      apifyConfig,
      { headers: { 'Content-Type': 'application/json' }, timeout: 300000 }
    );

    const runId = runResponse.data.data.id;
    const datasetId = runResponse.data.data.defaultDatasetId;

    const results = await waitForApifyResults(runId, datasetId);

    const withPhone = results.filter((r) => r.phone && r.phone.trim() !== '');

    const formatted = withPhone.map((place) => ({
      nombre: place.title,
      telefono: place.phone,
      direccion: place.address,
      sitioWeb: place.website,
      ubicacion: place.location,
      rating: place.totalScore,
      categoria: place.categoryName,
    }));

    res.json({
      success: true,
      query: searchQuery,
      totalEncontrados: results.length,
      totalConTelefono: withPhone.length,
      resultados: formatted,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check
app.get('/', (_req, res) => {
  res.json({
    message: 'Komerzia Market Hunter MCP is running',
    version: '2.0 (Apify)',
    apifyConfigured: !!APIFY_TOKEN,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Market Hunter MCP',
    apifyConfigured: !!APIFY_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Market Hunter MCP listening on port ${PORT}`);
  console.log(`📍 Version: 2.0 (Apify Integration)`);
});
