const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = 'compass~google-maps-extractor';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (trimmed.startsWith('+')) return trimmed;
  const dialCode = COUNTRY_DIAL_CODES[country] || null;
  if (!dialCode) return trimmed;
  let clean = trimmed.replace(/^\(0\)/, '').trim();
  clean = clean.replace(/^0+/, '').trim();
  return `${dialCode} ${clean}`;
}

async function searchPlacesWithApify({ category, city, country, maxResults = 200 }) {
  try {
    console.log(`🔍 Buscando con Apify: ${category} en ${city}, ${country} (max: ${maxResults})`);

    const searchQuery = `${category} en ${city}, ${country}`;

    const apifyConfig = {
      searchStringsArray: [searchQuery],
      maxCrawledPlaces: maxResults,
      language: 'es',
      deeperCityScrape: true,
      maxReviews: 0,
      maxImages: 0,
      scrapeReviewerName: false,
      scrapeReviewerId: false,
      scrapeReviewerUrl: false,
      scrapeReviewId: false,
      scrapeReviewUrl: false,
      scrapeResponseFromOwnerText: false
    };

    console.log(`📤 Config:`, JSON.stringify(apifyConfig, null, 2));

    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?maxItems=${maxResults}&maxTotalChargeUsd=5`,
      apifyConfig,
      {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${APIFY_TOKEN}` },
        timeout: 300000,
      }
    );

    const runId = runResponse.data.data.id;
    const datasetId = runResponse.data.data.defaultDatasetId;

    console.log(`✅ Scraper iniciado - Run ID: ${runId}`);

    const results = await waitForApifyResults(runId, datasetId);

    console.log(`📊 Resultados: ${results.length} lugares encontrados`);

    return results;
  } catch (error) {
    console.error(`❌ Error en Apify:`, error.message);
    return [];
  }
}

async function waitForApifyResults(runId, datasetId, maxIntentos = 150) {
  const intervalo = 3000;

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

    if (i % 10 === 0 && i > 0) {
      console.log(`⏳ Esperando... ${i * 3}s - Estado: ${status}`);
    }

    await sleep(intervalo);
  }

  throw new Error('Timeout');
}

function formatApifyResultToLead(place, country) {
  const phone = normalizePhone(place.phone, country);

  return {
    name: place.title || null,
    address: place.address || null,
    rating: place.totalScore || null,
    location: place.location ? { lat: place.location.lat, lng: place.location.lng } : null,
    place_id: place.placeId || null,
    phone: phone,
    website: place.website || null,
    category: place.categoryName || null,
    reviews: place.reviewsCount || 0,
    hours: place.openingHours || null,
  };
}

app.post('/run-campaign', async (req, res) => {
  const startTime = Date.now();

  try {
    const {
      campaignId,
      campaignName,
      categories = [],
      city,
      country,
      maxResultsPerCategory = 200,
    } = req.body || {};

    if (!campaignId || !city || !country) {
      return res.status(400).json({
        error: 'Parámetros inválidos',
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
        error: 'Se requiere al menos una categoría',
      });
    }

    if (!APIFY_TOKEN) {
      return res.status(500).json({
        error: 'Falta APIFY_TOKEN',
      });
    }

    console.log(`🚀 Campaña: ${campaignName || campaignId}`);
    console.log(`📍 ${city}, ${country}`);
    console.log(`🏷️ ${categoriesArray.join(', ')}`);
    console.log(`🔢 Max: ${maxResultsPerCategory}`);

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

      for (const place of apifyResults) {
        const placeId = place.placeId || place.place_id;
        if (!placeId) continue;
        if (!allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }

      if (categoriesArray.length > 1) {
        await sleep(2000);
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());
    console.log(`📊 Total únicos: ${allPlaces.length}`);

    const placesWithPhone = allPlaces.filter((p) => p.phone && p.phone.trim() !== '');
    console.log(`📞 Con teléfono: ${placesWithPhone.length}`);

    const leads = placesWithPhone.map((place) => formatApifyResultToLead(place, country));

    const total = leads.length;
    const ratings = leads.map((l) => (typeof l.rating === 'number' ? l.rating : null)).filter((r) => r !== null);
    const avgRating = ratings.length > 0 ? Number((ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)) : 0;
    const executionTime = Date.now() - startTime;

    console.log(`✅ Completado en ${(executionTime / 1000).toFixed(2)}s`);

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
    console.error('❌ Error:', err);
    return res.status(500).json({
      error: 'Error ejecutando campaña',
      details: err.message,
    });
  }
});

app.get('/', (_req, res) => {
  res.json({
    message: 'Komerzia Market Hunter MCP',
    version: '2.0',
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
  console.log(`🚀 Market Hunter MCP on port ${PORT}`);
  console.log(`📍 Version: 2.0`);
});
