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

const campaignResults = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const COUNTRY_DIAL_CODES = {
  'Bolivia': '+591',
  'Estado Plurinacional de Bolivia': '+591',
  'Paraguay': '+595',
  'España': '+34',
  'Mexico': '+52',
  'México': '+52',
  'Argentina': '+54',
  'Chile': '+56',
  'Peru': '+51',
  'Perú': '+51'
};

function normalizePhone(phone, country) {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return trimmed;
  const dialCode = COUNTRY_DIAL_CODES[country] || null;
  if (!dialCode) return trimmed;
  let clean = trimmed.replace(/^\(0\)/, '').trim();
  clean = clean.replace(/^0+/, '').trim();
  return dialCode + ' ' + clean;
}

async function searchPlacesWithApify(category, city, country, maxResults) {
  try {
    console.log('Buscando: ' + category + ' en ' + city + ', ' + country);

    const allPlaces = new Map();
    const numSearches = Math.ceil(maxResults / 20);
    
    const searchVariations = [
      category + ' ' + city + ' ' + country,
      category + ' en ' + city,
      'mejores ' + category + ' ' + city,
      category + ' ' + city + ' centro',
      category + ' ' + city + ' zona norte',
      category + ' ' + city + ' zona sur',
      category + ' cerca de ' + city,
      'top ' + category + ' ' + city,
      category + ' recomendados ' + city,
      category + ' populares ' + city
    ];

    for (let i = 0; i < Math.min(numSearches, searchVariations.length); i++) {
      const searchQuery = searchVariations[i];
      
      const apifyConfig = {
        searchStringsArray: [searchQuery],
        maxCrawledPlaces: 20,
        language: 'es',
        deeperCityScrape: false,
        maxReviews: 0,
        maxImages: 0
      };

      console.log('[' + (i + 1) + '/' + numSearches + '] ' + searchQuery);

      const runResponse = await axios.post(
        'https://api.apify.com/v2/acts/' + APIFY_ACTOR_ID + '/runs?token=' + APIFY_TOKEN + '&maxTotalChargeUsd=7',
        apifyConfig,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );

      const runId = runResponse.data.data.id;
      const datasetId = runResponse.data.data.defaultDatasetId;

      const results = await waitForApifyResults(runId, datasetId);
      
      let newPlaces = 0;
      for (const place of results) {
        if (!allPlaces.has(place.placeId)) {
          allPlaces.set(place.placeId, place);
          newPlaces++;
        }
      }

      console.log('  +' + newPlaces + ' | Total: ' + allPlaces.size);

      if (allPlaces.size >= maxResults) {
        console.log('Objetivo alcanzado');
        break;
      }

      await sleep(2000);
    }

    const finalResults = Array.from(allPlaces.values());
    console.log('Total final: ' + finalResults.length);
    return finalResults;

  } catch (error) {
    console.error('Error: ' + error.message);
    return [];
  }
}

async function waitForApifyResults(runId, datasetId) {
  const maxIntentos = 40;
  const intervalo = 3000;

  for (let i = 0; i < maxIntentos; i++) {
    try {
      const statusResponse = await axios.get(
        'https://api.apify.com/v2/acts/' + APIFY_ACTOR_ID + '/runs/' + runId + '?token=' + APIFY_TOKEN,
        { timeout: 5000 }
      );

      const status = statusResponse.data.data.status;

      if (status === 'SUCCEEDED') {
        const resultsResponse = await axios.get(
          'https://api.apify.com/v2/datasets/' + datasetId + '/items?token=' + APIFY_TOKEN,
          { timeout: 10000 }
        );
        return resultsResponse.data || [];
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        return [];
      }

      await sleep(intervalo);
    } catch (err) {
      await sleep(intervalo);
    }
  }

  return [];
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
    hours: place.openingHours || null
  };
}

async function processCampaignInBackground(campaignData) {
  const campaignId = campaignData.campaignId;
  
  try {
    console.log('\n=== PROCESANDO: ' + campaignId + ' ===');
    
    campaignResults.set(campaignId, {
      status: 'processing',
      progress: 0,
      message: 'Iniciando busqueda...'
    });

    const allPlacesMap = new Map();

    for (let idx = 0; idx < campaignData.categories.length; idx++) {
      const catStr = campaignData.categories[idx];
      if (!catStr.trim()) continue;

      const progress = Math.round(((idx + 1) / campaignData.categories.length) * 100);
      campaignResults.set(campaignId, {
        status: 'processing',
        progress: progress,
        message: 'Buscando: ' + catStr.trim()
      });

      const apifyResults = await searchPlacesWithApify(
        catStr.trim(),
        campaignData.city,
        campaignData.country,
        campaignData.maxResultsPerCategory
      );

      for (const place of apifyResults) {
        const placeId = place.placeId;
        if (placeId && !allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());
    const placesWithPhone = allPlaces.filter(function(p) {
      return p.phone && p.phone.trim();
    });
    
    const leads = placesWithPhone.map(function(p) {
      return formatApifyResultToLead(p, campaignData.country);
    });

    const ratings = leads.map(function(l) { return l.rating; }).filter(function(r) { return typeof r === 'number'; });
    const avgRating = ratings.length > 0 ? Number((ratings.reduce(function(sum, r) { return sum + r; }, 0) / ratings.length).toFixed(2)) : 0;

    const summary = {
      total: leads.length,
      totalFound: allPlaces.length,
      withPhone: placesWithPhone.length,
      avgRating: avgRating
    };

    console.log('=== COMPLETADO: ' + leads.length + ' leads ===\n');

    campaignResults.set(campaignId, {
      status: 'completed',
      progress: 100,
      campaignId: campaignId,
      campaignName: campaignData.campaignName,
      categories: campaignData.categories,
      city: campaignData.city,
      country: campaignData.country,
      leads: leads,
      summary: summary
    });

    setTimeout(function() {
      campaignResults.delete(campaignId);
    }, 3600000);

  } catch (error) {
    console.error('Error en background:', error.message);
    campaignResults.set(campaignId, {
      status: 'failed',
      error: error.message
    });
  }
}

app.post('/run-campaign', async (req, res) => {
  try {
    const body = req.body || {};
    const campaignId = body.campaignId;
    const campaignName = body.campaignName;
    const categories = body.categories || [];
    const city = body.city;
    const country = body.country;
    const maxResultsPerCategory = body.maxResultsPerCategory || 200;

    if (!campaignId || !city || !country) {
      return res.status(400).json({ error: 'Faltan parametros' });
    }

    let categoriesArray = Array.isArray(categories) ? categories : [categories];

    if (!categoriesArray.length) {
      return res.status(400).json({ error: 'Se requiere categoria' });
    }

    if (!APIFY_TOKEN) {
      return res.status(500).json({ error: 'Falta APIFY_TOKEN' });
    }

    console.log('Iniciando campana: ' + campaignName);

    const campaignData = {
      campaignId: campaignId,
      campaignName: campaignName,
      categories: categoriesArray,
      city: city,
      country: country,
      maxResultsPerCategory: maxResultsPerCategory
    };

    processCampaignInBackground(campaignData).catch(function(err) {
      console.error('Error:', err);
    });

    return res.json({
      status: 'processing',
      message: 'Campana iniciada',
      campaignId: campaignId,
      statusUrl: '/campaign-status/' + campaignId
    });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({
      error: 'Error iniciando campana',
      details: err.message
    });
  }
});

app.get('/campaign-status/:campaignId', function(req, res) {
  const campaignId = req.params.campaignId;
  
  if (!campaignResults.has(campaignId)) {
    return res.status(404).json({
      status: 'not_found',
      message: 'Campana no encontrada'
    });
  }

  const result = campaignResults.get(campaignId);
  return res.json(result);
});

app.get('/', function(req, res) {
  res.json({
    message: 'Komerzia Market Hunter MCP',
    version: '3.1 - Apify Async',
    apifyConfigured: !!APIFY_TOKEN
  });
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, function() {
  console.log('Server on port ' + PORT);
});
