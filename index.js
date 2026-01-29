const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

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
    const numSearches = Math.ceil(maxResults / 60);
    
    const searchVariations = [
      category + ' ' + city + ' ' + country,
      category + ' cerca de ' + city + ' ' + country,
      'mejores ' + category + ' ' + city + ' ' + country,
      'top ' + category + ' ' + city + ' ' + country
    ];

    for (let i = 0; i < Math.min(numSearches, searchVariations.length); i++) {
      const query = searchVariations[i];
      console.log('Variacion ' + (i + 1) + ': ' + query);
      
      const places = await searchGooglePlacesAPI(query);
      
      for (const place of places) {
        if (!allPlaces.has(place.place_id)) {
          allPlaces.set(place.place_id, place);
        }
      }

      console.log('Acumulados: ' + allPlaces.size + ' lugares');

      if (allPlaces.size >= maxResults) break;
      
      if (i < numSearches - 1) {
        await sleep(1000);
      }
    }

    const results = Array.from(allPlaces.values());
    console.log('Total: ' + results.length + ' lugares');
    return results;

  } catch (error) {
    console.error('Error: ' + error.message);
    return [];
  }
}

async function searchGooglePlacesAPI(query) {
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: {
        query: query,
        key: GOOGLE_MAPS_API_KEY,
        language: 'es'
      },
      timeout: 10000
    });

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      console.error('Google API status: ' + response.data.status);
      if (response.data.error_message) {
        console.error('Error message: ' + response.data.error_message);
      }
      return [];
    }

    if (response.data.status === 'ZERO_RESULTS') {
      console.log('Sin resultados para esta busqueda');
      return [];
    }

    const places = response.data.results || [];
    console.log('Google devolvio: ' + places.length + ' lugares');
    
    const detailedPlaces = [];
    
    for (const place of places) {
      try {
        const details = await getPlaceDetails(place.place_id);
        if (details) {
          const combined = Object.assign({}, place, details);
          detailedPlaces.push(combined);
        } else {
          detailedPlaces.push(place);
        }
        await sleep(100);
      } catch (err) {
        console.error('Error obteniendo detalles: ' + err.message);
        detailedPlaces.push(place);
      }
    }

    return detailedPlaces;

  } catch (error) {
    console.error('Error en Google Places API: ' + error.message);
    return [];
  }
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
      timeout: 5000
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

app.post('/run-campaign', async (req, res) => {
  const startTime = Date.now();

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

    console.log('Campana: ' + city + ', ' + country + ' - ' + categoriesArray.join(', '));

    const allPlacesMap = new Map();

    for (const catStr of categoriesArray) {
      if (!catStr.trim()) continue;

      const googleResults = await searchWithGooglePlaces(catStr.trim(), city, country, maxResultsPerCategory);

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
      return formatGooglePlaceToLead(p, country);
    });

    const ratings = leads.map(function(l) { return l.rating; }).filter(function(r) { return typeof r === 'number'; });
    const avgRating = ratings.length > 0 ? Number((ratings.reduce(function(sum, r) { return sum + r; }, 0) / ratings.length).toFixed(2)) : 0;

    const executionTime = Date.now() - startTime;

    console.log('Completado: ' + leads.length + ' leads en ' + (executionTime / 1000).toFixed(1) + 's');

    return res.json({
      campaignId: campaignId,
      campaignName: campaignName,
      categories: categoriesArray,
      city: city,
      country: country,
      leads: leads,
      executionTime: executionTime,
      summary: {
        total: leads.length,
        totalFound: allPlaces.length,
        withPhone: placesWithPhone.length,
        avgRating: avgRating
      }
    });
  } catch (err) {
    console.error('Error: ' + err.message);
    return res.status(500).json({
      error: 'Error en campana',
      details: err.message
    });
  }
});

app.get('/', function(req, res) {
  res.json({
    message: 'Komerzia Market Hunter MCP',
    version: '2.0',
    googleMapsConfigured: !!GOOGLE_MAPS_API_KEY
  });
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    googleMapsConfigured: !!GOOGLE_MAPS_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, function() {
  console.log('Server on port ' + PORT);
});
