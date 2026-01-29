const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

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

async function searchWithGooglePlaces(category, city, country, maxResults) {
  try {
    console.log('Buscando: ' + category + ' en ' + city + ', ' + country);

    const allPlaces = new Map();
    
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
      category + ' populares ' + city,
      category + ' ' + city + ' zona este',
      category + ' ' + city + ' zona oeste',
      'donde encontrar ' + category + ' ' + city,
      category + ' baratos ' + city,
      category + ' economicos ' + city
    ];

    for (let i = 0; i < searchVariations.length; i++) {
      const query = searchVariations[i];
      console.log('[' + (i + 1) + '/' + searchVariations.length + '] ' + query);
      
      const places = await searchGooglePlacesAPIFast(query);
      
      let newPlaces = 0;
      for (const place of places) {
        if (!allPlaces.has(place.place_id)) {
          allPlaces.set(place.place_id, place);
          newPlaces++;
        }
      }

      console.log('  +' + newPlaces + ' | Total: ' + allPlaces.size);

      if (allPlaces.size >= maxResults) {
        break;
      }
      
      await sleep(800);
    }

    const allPlacesArray = Array.from(allPlaces.values());
    console.log('Obteniendo detalles...');
    const placesWithDetails = await getPhoneDetailsForPlaces(allPlacesArray);
    
    return placesWithDetails;

  } catch (error) {
    console.error('Error: ' + error.message);
    return [];
  }
}

async function searchGooglePlacesAPIFast(query) {
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: {
        query: query,
        key: GOOGLE_MAPS_API_KEY,
        language: 'es'
      },
      timeout: 8000
    });

    if (response.data.status === 'OK') {
      return response.data.results || [];
    }
    
    return [];

  } catch (error) {
    return [];
  }
}

async function getPhoneDetailsForPlaces(places) {
  const detailedPlaces = [];
  const batchSize = 10;
  
  for (let i = 0; i < places.length; i += batchSize) {
    const batch = places.slice(i, i + batchSize);
    
    const promises = batch.map(function(place) {
      return getPlaceDetails(place.place_id).then(function(details) {
        if (details) {
          return Object.assign({}, place, details);
        }
        return place;
      }).catch(function() {
        return place;
      });
    });
    
    const results = await Promise.all(promises);
    detailedPlaces.push.apply(detailedPlaces, results);
    
    if (i + batchSize < places.length) {
      await sleep(100);
    }
  }
  
  return detailedPlaces;
}

async function getPlaceDetails(placeId) {
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        fields: 'formatted_phone_number,international_phone_number,website,opening_hours',
        key: GOOGLE_MAPS_API_KEY,
        language: 'es'
      },
      timeout: 3000
    });

    if (response.data.status === 'OK') {
      return response.data.result;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

function formatGooglePlaceToLead(place, country) {
  const phone = normalizePhone(place.formatted_phone_number || place.international_phone_number, country);

  let location = null;
  if (place.geometry && place.geometry.location) {
    location = {
      lat: place.geometry.location.lat,
      lng: place.geometry.location.lng
    };
  }

  let category = null;
  if (place.types && place.types.length > 0) {
    category = place.types[0];
  }

  let hours = null;
  if (place.opening_hours && place.opening_hours.weekday_text) {
    hours = place.opening_hours.weekday_text.join(', ');
  }

  return {
    name: place.name || null,
    address: place.formatted_address || null,
    rating: place.rating || null,
    location: location,
    place_id: place.place_id || null,
    phone: phone,
    website: place.website || null,
    category: category,
    reviews: place.user_ratings_total || 0,
    hours: hours
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

      const googleResults = await searchWithGooglePlaces(
        catStr.trim(),
        campaignData.city,
        campaignData.country,
        campaignData.maxResultsPerCategory
      );

      for (const place of googleResults) {
        const placeId = place.place_id;
        if (placeId && !allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());
    const placesWithPhone = allPlaces.filter(function(p) {
      const phone = p.formatted_phone_number || p.international_phone_number;
      return phone && String(phone).trim();
    });
    
    const leads = placesWithPhone.map(function(p) {
      return formatGooglePlaceToLead(p, campaignData.country);
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

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ error: 'Falta GOOGLE_MAPS_API_KEY' });
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
    version: '3.0 - Async',
    googleMapsConfigured: !!GOOGLE_MAPS_API_KEY
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
