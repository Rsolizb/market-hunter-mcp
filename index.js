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

async function searchWithGooglePlaces(category, city, country, maxResults) {
  try {
    console.log(`🔍 ${category} in ${city}, ${country}`);

    const numSearches = Math.ceil(maxResults / 60);
    const allPlaces = new Map();
    
    const searchVariations = [
      `${category} ${city} ${country}`,
      `${category} near ${city} ${country}`,
      `best ${category} ${city} ${country}`,
      `top ${category} ${city} ${country}`,
    ];

    for (let i = 0; i < Math.min(numSearches, searchVariations.length); i++) {
      const query = searchVariations[i];
      const places = await searchGooglePlacesAPI(query);
      
      for (const place of places) {
        if (!allPlaces.has(place.place_id)) {
          allPlaces.set(place.place_id, place);
        }
      }

      if (allPlaces.size >= maxResults) break;
      
      if (i < numSearches - 1) {
        await sleep(1000);
      }
    }

    const results = Array.from(allPlaces.values());
    console.log(`📊 ${results.length} resultados`);
    return results;

  } catch (error) {
    console.error(`❌ ${error.message}`);
    return [];
  }
}

async function searchGooglePlacesAPI(query) {
  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      {
        params: {
          query: query,
          key: GOOGLE_MAPS_API_KEY,
          language: 'es'
        },
        timeout: 10000
      }
    );

    if (response.data.status !== 'OK') {
      console.error(`Google API status: ${response.data.status}`);
      return [];
    }

    const places = response.data.results || [];
    const detailedPlaces = [];
    
    for (const place of places) {
      try {
        const details = await getPlaceDetails(place.place_id);
        if (details) {
          detailedPlaces.push({
            ...place,
            ...details
          });
        }
        await sleep(100);
      } catch (err) {
        console.error(`Error obteniendo detalles: ${err.message}`);
      }
    }

    return detailedPlaces;

  } catch (error) {
    console.error(`Error en Google Places API: ${error.message}`);
    return [];
  }
}

async function getPlaceDetails(placeId) {
  try {
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      {
        params: {
          place_id: placeId,
          fields: 'formatted_phone_number,international_phone_number,website,opening_hours,url',
          key: GOOGLE_MAPS_API_KEY,
          language: 'es'
        },
        timeout: 5000
      }
    );

    if (response.data.status === 'OK') {
      return response.data.result;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

function formatGooglePlaceToLead(place, country) {
  const phone = normalizePhone(
    place.formatted_phone_number || place.international_phone_number,
    country
  );

  return {
    name: place.name || null,
    address: place.formatted_address || null,
    rating: place.rating || null,
    location: place.geometry && place.geometry.location ? {
      lat: place.geometry.location.lat,
      lng: place.geometry.location.lng
    } : null,
    place_id: place.place_id || null,
    phone: phone,
    website: place.website || null,
    category: place.types && place.types.length > 0 ? place.types[0] : null,
    reviews: place.user_ratings_total || 0,
    hours: place.opening_hours && place.opening_hours.weekday_text ? place.opening_hours.weekday_text.join(', ') : null,
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

    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ error: 'Falta GOOGLE_MAPS_API_KEY' });
    }

    console.log(`🚀 ${city}, ${country} - ${categoriesArray.join(', ')}`);

    const allPlacesMap = new Map();

    for (const catStr of categoriesArray) {
      if (!catStr.trim()) continue;

      const googleResults = await searchWithGooglePlaces(
        catStr.trim(),
        city,
        country,
        maxResultsPerCategory
      );

      for (const place of googleResults) {
        const placeId = place.place_id;
        if (placeId && !allPlacesMap.has(placeId)) {
          allPlacesMap.set(placeId, place);
        }
      }
    }

    const allPlaces = Array.from(allPlacesMap.values());
    const placesWithPhone = allPlaces.filter((p) => {
      const phone = p.formatted_phone_number || p.international_phone_number;
      return phone && String(phone).trim();
    });
    
    const leads = placesWithPhone.map((p) => formatGooglePlaceToLead(p, country));

    const ratings = leads.map((l) => l.rating).filter((r) => typeof r === 'number');
    const avgRating = ratings.length > 0 
      ? Number((ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)) 
      : 0;

    const executionTime = Date.now() - startTime;

    console.log(`✅ ${leads.length} leads - ${(executionTime / 1000).toFixed(1)}s`);

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

app.get('/', (req, res) => {
  res.json({
    message: 'Komerzia Market Hunter MCP',
    version: '2.0',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
});
```

---

## 🔑 Cambios que corrigen el error:

1. **Eliminé destructuring opcional** en funciones - causaba problemas
2. **Arreglé los optional chaining** (`?.`) - los puse como condicionales normales
3. **Quité `_req` y `_res`** - uso normal `req, res`
4. **Simplifiqué accesos anidados** - uso condicionales `if` en lugar de `?.`

---

## ⚙️ Antes de probar:

**Asegúrate de agregar la variable de entorno en Railway:**
```
GOOGLE_MAPS_API_KEY = AIzaSyAa6y6xcuVuGu1PSTu1HCv5u3jCmGv66nI
