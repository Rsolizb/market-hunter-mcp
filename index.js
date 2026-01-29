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
    const searchQuery = `${category} ${city}, ${country}`;

    const apifyConfig = {
      searchStringsArray: [searchQuery],
      maxCrawledPlaces: maxResults,
      maxCrawledPlacesPerSearch: maxResults,
      language: 'es',
      deeperCityScrape: true,
      maxReviews: 0,
      maxImages: 0,
      scrapeReviewerName: false,
      scrapeReviewerId: false,
      scrapeReviewerUrl: false,
      scrapeReviewId: false,
      scrapeReviewUrl: false,
      scrapeResponseFromOwnerText: false,
      exportPlaceUrls: false,
      includeWebResults: false,
      scrapeDirections: false,
      scrapeOpeningHours: true,
      scrapePhone: true,
      scrapePeopleAlsoSearch: false,
      scrapeReviews: false
    };

    console.log(`🔍 Buscando: ${searchQuery}`);

    // PARÁMETROS EXACTOS DE TU PRUEBA EN LA URL
    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?maxItems=${maxResults}&maxTotalChargeUsd=20&waitForFinish=300&timeout=300`,
      apifyConfig,
      {
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APIFY_TOKEN}`
        },
        timeout: 320000, // 320 segundos (más que waitForFinish)
      }
    );

    const runId = runResponse.data.data.id;
    const datasetId = runResponse.data.data.defaultDatasetId;
    const status = runResponse.data.data.status;

    console.log(`✅ Run: ${runId}, Status: ${status}`);

    // Si ya terminó, obtener resultados directamente
    if (status === 'SUCCEEDED') {
      console.log(`✅ Completado inmediatamente`);
      const results = await getDatasetResults(datasetId);
      console.log(`📊 ${results.length} resultados`);
      return results;
    }

    // Si no terminó, seguir esperando
    console.log(`⏳ Esperando...`);
    const results = await waitForApifyResults(runId, datasetId, 20);
    console.log(`📊 ${results.length} resultados`);
    return results;

  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return [];
  }
}

async function waitForApifyResults(runId, datasetId, maxIntentos = 20) {
  const intervalo = 5000; // 5 segundos

  for (let i = 0; i < maxIntentos; i++) {
    try {
      const statusResponse = await axios.get(
        `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_TOKEN}`,
        { timeout: 5000 }
      );

      const status = statusResponse.data.data.status;

      if (status === 'SUCCEEDED') {
        return await getDatasetResults(datasetId);
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        console.error(`❌ ${status}`);
        return [];
      }

      console.log(`⏳ ${i * 5}s - ${status}`);
      await sleep(intervalo);
    } catch (err) {
      console.error(`⚠️ ${err.message}`);
      await sleep(intervalo);
    }
  }

  console.log(`⏱️ Timeout - obteniendo parciales`);
  try {
    return await getDatasetResults(datasetId);
  } catch {
    return [];
  }
}

async function getDatasetResults(datasetId) {
  let allResults = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    try {
      const response = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&offset=${offset}&limit=${limit}`,
        { timeout: 10000 }
      );

      const items = response.data;
      
      if (!items || items.length === 0) break;

      allResults = allResults.concat(items);
      
      if (allResults.length > offset + limit / 2) {
        console.log(`📥 ${allResults.length} resultados obtenidos`);
      }

      if (items.length < limit) break;
      offset += limit;
    } catch (error) {
      console.error(`❌ Error dataset: ${error.message}`);
      break;
    }
  }

  return allResults;
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
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    let categoriesArray = Array.isArray(categories) ? categories : [categories];

    if (!categoriesArray.length) {
      return res.status(400).json({ error: 'Se requiere categoría' });
    }

    if (!APIFY_TOKEN) {
      return res.status(500).json({ error: 'Falta APIFY_TOKEN' });
    }

    console.log(`\n🚀 ${city}, ${country} - ${categoriesArray.join(', ')}`);

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

    console.log(`✅ ${leads.length} leads en ${(executionTime / 1000).toFixed(1)}s\n`);

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
    console.error('❌', err.message);
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
