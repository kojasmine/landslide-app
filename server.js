const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- 1. SERVE THE APP ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});


// --- 2. SEARCH API (SMARTER VERSION) ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    
    if (!q || q.length < 1) return res.json([]);

    // 1. Split user input into words (e.g., "123 Main" -> ["123", "Main"])
    const words = q.trim().split(/\s+/);

    // 2. Build a query that requires EVERY word to be present
    // We create a confusing looking string like: "PARCEL_TYP" ILIKE $1 AND "PARCEL_TYP" ILIKE $2 ...
    const conditions = words.map((_, index) => `"PARCEL_TYP" ILIKE $${index + 1}`).join(' AND ');

    // 3. Add % symbols to every word (e.g., "%123%", "%Main%")
    const searchTerms = words.map(w => `%${w}%`);

    const query = `
        SELECT id, 
               "PIN" as owner_name, 
               "PARCEL_TYP" as address, 
               ST_X(ST_Centroid(geom)) as lng, 
               ST_Y(ST_Centroid(geom)) as lat
        FROM "Parcels_real"
        WHERE (${conditions}) 
           OR "PIN" ILIKE $1  -- Keep PIN search simple (just the first word/term)
        LIMIT 5;
    `;

    try {
        // Pass the array of words to the database
        const result = await pool.query(query, searchTerms);
        res.json(result.rows);
    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).send("Search Error");
    }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});