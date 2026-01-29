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

async function searchPlacesWithApify({ category, city, country, maxResults = 100 }) {
  try {
    const searchQuery = `${category} ${city}, ${country}`;

    const apifyConfig = {
      searchStringsArray: [searchQuery],
      maxCrawledPlaces: maxResults,
      language: 'es',
      deeperCityScrape: false,
      maxReviews: 0,
      maxImages: 0
    };

    // maxTotalChargeUsd=20
    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?maxItems=${maxResults}&maxTotalChargeUsd=20`,
      apifyConfig,
      {
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APIFY_TOKEN}`
        },
        timeout: 8000,
      }
    );

    const runId = runResponse.data.data.id;
    const datasetId = runResponse.data.data.defaultDatasetId;

    const results = await waitForApifyResults(runId, datasetId, 40);
    return results;

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return [];
  }
}

async function waitForApifyResults(runId, datasetId, maxIntentos = 40) {
  const intervalo = 3000;

  for (let i = 0; i < maxIntentos; i++) {
    try {
      const statusResponse = await axios.get(
        `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_TOKEN}`,
        { timeout: 4000 }
      );

      const status = statusResponse.data.data.status;

      if (status === 'SUCCEEDED') {
        return await getDatasetResults(datasetId);
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        return [];
      }

      await sleep(intervalo);
    } catch (err) {
      await sleep(intervalo);
    }
  }

  try {
    return await getDatasetResults(datasetId);
  } catch {
    return [];
  }
}

async function getDatasetResults(datasetId) {
  const response = await axios.get(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=1000`,
    { timeout: 8000 }
  );
  return response.data || [];
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
      maxResultsPerCategory = 100,
    } = req.body || {};

    if (!campaignId || !city || !country) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    let categoriesArray = Array.isArray(categories) ? categories : [categories];

    if (!categoriesArray.length) {
      return res.status(400).json({ error: 'Se requiere categoría' });
    }

    const allPlacesMap = new Map();

    for (const catStr of categoriesArray) {
      if (!catStr.trim()) continue;

      const apifyResults = await searchPlacesWithApify({
        category: catStr.trim(),
        city,
        country,
        maxResults: maxResultsPerCategory,
      });

      for (const place of apifyResults) {
        const placeId = place.placeId || place.place_id;
        if (placeId && !allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());
    const placesWithPhone = allPlaces.filter((p) => p.phone && p.phone.trim());
    const leads = placesWithPhone.map((p) => formatApifyResultToLead(p, country));

    const ratings = leads.map((l) => l.rating).filter((r) => typeof r === 'number');
    const avgRating = ratings.length > 0 
      ? Number((ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)) 
      : 0;

    const executionTime = Date.now() - startTime;

    return res.json({
      campaignId,
      campaignName,
      categories: categoriesArray,
      city,
      country,
      leads,
      executionTime,
      summary: {
        total: leads.length,
        totalFound: allPlaces.length,
        withPhone: placesWithPhone.length,
        avgRating,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Error en campaña',
      details: err.message,
    });
  }
});

app.get('/', (_req, res) => {
  res.json({
    message: 'Komerzia Market Hunter MCP',
    version: '2.0',
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
});
