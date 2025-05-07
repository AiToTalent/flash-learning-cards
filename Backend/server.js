// Import necessary modules
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const pdf = require('pdf-parse');
const cheerio = require('cheerio');
const mammoth = require("mammoth");
const path = require('path');
const fs = require('fs');

// Import Google Generative AI and dotenv
require('dotenv').config();
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const app = express();

// Configure Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI, modelFlashcard, modelQuiz;
if (!GEMINI_API_KEY) {
    console.warn("WARNUNG: GEMINI_API_KEY ist nicht definiert. Die KI-Funktionen sind deaktiviert.");
} else {
    try {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        modelFlashcard = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        modelQuiz = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Using flash for quiz too, can be changed
        console.log("Gemini API Client initialisiert.");
    } catch (e) {
        console.error("Fehler bei der Initialisierung des Gemini API Clients:", e);
        genAI = null; modelFlashcard = null; modelQuiz = null;
    }
}

const generationConfig = { temperature: 0.6, topK: 1, topP: 1, maxOutputTokens: 4096 };
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (allowedTypes.includes(file.mimetype)) { cb(null, true); }
        else { cb(new Error(`Ungültiger Dateityp: ${file.mimetype}.`), false); }
    }
});

// --- Text Extraction Function --- (remains the same)
async function extractText(inputType, data) { /* ... */
    console.log(`Attempting to extract text from type: ${inputType}`);
    if (inputType === 'text') { return Promise.resolve(data || ''); }
    else if (inputType === 'file' && data && data.buffer) {
        const fileBuffer = data.buffer; const mimetype = data.mimetype; console.log(`Processing file with mimetype: ${mimetype}`);
        if (mimetype === 'text/plain') { try { const text = fileBuffer.toString('utf-8'); console.log(`Extracted ${text.length} chars from TXT.`); return Promise.resolve(text); } catch (e) { console.error("Error reading TXT:", e); return Promise.reject(new Error("Textdatei lesen fehlgeschlagen.")); } }
        else if (mimetype === 'application/pdf') { try { console.log("Parsing PDF..."); const pdfData = await pdf(fileBuffer); console.log(`Extracted ${pdfData.text.length} chars from PDF.`); return Promise.resolve(pdfData.text); } catch (e) { console.error("Error parsing PDF:", e); return Promise.reject(new Error("PDF-Verarbeitung fehlgeschlagen.")); } }
        else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { try { console.log("Parsing DOCX..."); const result = await mammoth.extractRawText({ buffer: fileBuffer }); const text = result.value; result.messages.forEach(m => console.log(`Mammoth msg (${m.type}): ${m.message}`)); console.log(`Extracted ${text.length} chars from DOCX.`); return Promise.resolve(text); } catch (e) { console.error("Error parsing DOCX:", e); return Promise.reject(new Error("DOCX-Verarbeitung fehlgeschlagen.")); } }
        else { console.warn(`Unsupported file type: ${mimetype}`); return Promise.reject(new Error(`Nicht unterstützter Dateityp: ${mimetype}`)); }
    } else if (inputType === 'url') {
        const url = data; console.log(`Fetching URL: ${url}`);
        try {
            if (!url || !url.startsWith('http')) { throw new Error("Ungültige URL."); }
            if (/\.(jpg|jpeg|png|gif|mp3|mp4|zip|exe|dmg)$/i.test(url)) { console.log(`Binary file URL skipped: ${url}`); return Promise.resolve(`[Binärdatei (${url})]`); }
            const response = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 ...' }, validateStatus: (s) => s >= 200 && s < 600 });
            const contentType = response.headers['content-type']; console.log(`URL status: ${response.status}, Type: ${contentType}`);
            if (response.status >= 400) { throw new Error(`URL Fehler: Status ${response.status}`); }
            if (!contentType || !contentType.toLowerCase().includes('html')) { console.log(`Kein HTML (${contentType}).`); if (contentType?.toLowerCase().includes('text/plain') && typeof response.data === 'string') { return Promise.resolve(response.data.substring(0, 5000)); } return Promise.resolve(`[Kein HTML (${contentType})]`); }
            const htmlContent = response.data; const $ = cheerio.load(htmlContent); $('script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"]').remove(); let text = $('main').text() || $('article').text() || $('.content').text() || $('.post-content').text() || $('body').text(); text = text.replace(/\s\s+/g, ' ').trim(); console.log(`Extracted ${text.length} chars from URL.`);
            if (text.length === 0) { console.warn("Extracted text from URL empty."); return Promise.resolve("[Kein Text von URL extrahiert.]"); }
            else if (text.length > 0 && text.length < 150) { console.warn(`Extracted text from URL very short (${text.length} chars).`); }
            return Promise.resolve(text);
        } catch (error) { console.error(`URL Error ${url}:`, error.message); if (error.code === 'ECONNABORTED') { return Promise.reject(new Error('URL Timeout.')); } else if (error.response) { return Promise.reject(new Error(`URL Fehler: Status ${error.response.status}`)); } else if (error.request) { return Promise.reject(new Error('URL Fehler: Keine Antwort.')); } else { return Promise.reject(new Error(`URL Fehler: ${error.message}`)); } }
    } else { return Promise.reject(new Error('Ungültiger Input-Typ.')); }
 }

// --- AI Flashcard Generation Function --- (remains the same)
async function generateFlashcardsAI(textContent, maxCards = 15) { /* ... */
    if (!genAI || !modelFlashcard) { throw new Error("KI-Dienst (Flashcard) nicht verfügbar."); }
    console.log(`Calling Gemini for flashcards (max ${maxCards})...`); const numCards = Math.max(3, Math.min(25, maxCards));
    if (!textContent || textContent.trim().length < 10) { return [{ front: "Kein Inhalt?", back: "Text zu kurz." }]; }
    const MAX_TEXT_LENGTH = 25000; const truncatedText = textContent.substring(0, MAX_TEXT_LENGTH); if(textContent.length > MAX_TEXT_LENGTH) { console.warn(`Text truncated.`); }
    const prompt = `Erstelle Lernkarten (Flashcards)... Erstelle maximal ${numCards} Lernkarten... Text: --- ${truncatedText} --- JSON-Array:`; // Simplified prompt for brevity
    try {
        const result = await modelFlashcard.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig, safetySettings });
        const response = result.response; console.log("Gemini response received (Flashcards).");
        if (!response?.candidates?.[0]?.content) { throw new Error(`Keine gültige KI-Antwort (Flashcards).`); }
        const aiTextResponse = response.candidates[0].content.parts[0].text; console.log("Raw AI text sample (Flashcards):", aiTextResponse.substring(0, 200) + "...");
        try {
            const startIndex = aiTextResponse.indexOf('['); const endIndex = aiTextResponse.lastIndexOf(']');
            if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) { throw new Error("KI-Antwort (Flashcards) ohne JSON-Array."); }
            const jsonString = aiTextResponse.substring(startIndex, endIndex + 1);
            const flashcards = JSON.parse(jsonString); if (!Array.isArray(flashcards)) { throw new Error("KI-Antwort (Flashcards) kein Array."); }
            console.log(`Parsed ${flashcards.length} flashcards.`); return flashcards.slice(0, numCards);
        } catch (parseError) { console.error("JSON parse error (Flashcards):", parseError); console.error("Raw response:", aiTextResponse.substring(0, 1000) + "..."); throw new Error(`KI-Antwort (Flashcards) nicht lesbar: ${parseError.message}`); }
    } catch (error) { console.error("Gemini API error (Flashcards):", error); throw new Error(error.message || "KI-Fehler (Flashcards)."); }
 }

// --- UPDATED: AI Quiz Generation Function ---
/**
 * Generates multiple-choice quiz questions using the Google Gemini API.
 * Allows for multiple correct answers.
 * @param {string} textContent - The text to generate quiz questions from.
 * @param {number} numQuestions - The desired number of quiz questions.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of quiz question objects.
 */
async function generateQuizAI(textContent, numQuestions = 5) {
    if (!genAI || !modelQuiz) {
        console.error("Gemini API client not initialized. Cannot generate quiz.");
        throw new Error("KI-Dienst (Quiz) ist nicht verfügbar (API-Schlüssel fehlt?).");
    }
    console.log(`Calling Google Gemini API for quiz generation (${numQuestions} questions)...`);
    const numberOfQuestions = Math.max(3, Math.min(15, numQuestions));
    console.log(`Requesting ${numberOfQuestions} quiz questions from AI.`);

    if (!textContent || textContent.trim().length < 50) {
        console.log("Text content too short for quiz generation.");
        return [];
    }
    const MAX_TEXT_LENGTH = 25000;
    const truncatedText = textContent.substring(0, MAX_TEXT_LENGTH);
    if(textContent.length > MAX_TEXT_LENGTH) { console.warn(`Text content truncated for quiz API call.`); }

    // --- UPDATED PROMPT FOR MULTIPLE CORRECT ANSWERS ---
    const prompt = `
        Erstelle basierend auf dem folgenden Text ein Multiple-Choice-Quiz mit Mehrfachauswahlmöglichkeit.
        Zielgruppe: Lernende, die den Inhalt des Textes verstehen und überprüfen möchten.
        Anforderungen:
        1.  Generiere genau ${numberOfQuestions} Fragen.
        2.  Jede Frage muss sich klar auf wichtige Informationen oder Schlüsselkonzepte im Text beziehen.
        3.  Formuliere die Fragen klar und eindeutig. Es kann EINE oder MEHRERE korrekte Antworten geben.
        4.  Erstelle für jede Frage genau 4 Antwortoptionen (ein Array von Strings).
        5.  Mindestens EINE der vier Optionen muss korrekt sein.
        6.  Die falschen Antwortoptionen (Distraktoren) müssen plausibel klingen, aber eindeutig falsch sein.
        7.  Gib das Ergebnis ausschließlich als JSON-Array zurück. Jedes Objekt im Array repräsentiert eine Frage und muss exakt die folgende Struktur haben:
            {
              "question": "Die Frage als String.",
              "options": ["Antwort A", "Antwort B", "Antwort C", "Antwort D"],
              "correctAnswerIndices": [index1, index2, ...] // Array mit den Indizes (0-3) ALLER korrekten Antworten.
            }
        8.  Stelle sicher, dass das gesamte Ergebnis valides JSON ist. Strings dürfen keine unmaskierten Zeilenumbrüche enthalten.

        Text:
        ---
        ${truncatedText}
        ---

        JSON-Array mit Quizfragen (Mehrfachauswahl möglich):
    `;
    // --- END OF UPDATED PROMPT ---

    try {
        const activeModel = modelQuiz || modelFlashcard;
        if (!activeModel) throw new Error("Kein gültiges KI-Modell für Quiz verfügbar.");

        const result = await activeModel.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig, safetySettings,
        });
        const response = result.response;
        console.log("Gemini API response received (Quiz).");

        if (!response?.candidates?.[0]?.content) {
             const blockReason = response?.promptFeedback?.blockReason;
             const finishReason = response?.candidates?.[0]?.finishReason;
             console.warn(`Gemini response blocked/empty (Quiz). Block: ${blockReason}, Finish: ${finishReason}`);
             throw new Error(`Keine gültige Quiz-Antwort von der KI erhalten.${blockReason ? ` Grund: ${blockReason}` : ''}${finishReason ? ` Status: ${finishReason}` : ''}`);
         }
        const aiTextResponse = response.candidates[0].content.parts[0].text;
        console.log("Raw AI text response sample (Quiz):", aiTextResponse.substring(0, 500) + "...");

        try {
             const startIndex = aiTextResponse.indexOf('[');
             const endIndex = aiTextResponse.lastIndexOf(']');
             console.log(`Found startIndex '[' at: ${startIndex} (Quiz)`);
             console.log(`Found endIndex ']' at: ${endIndex} (Quiz)`);
             if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) { throw new Error("KI-Antwort (Quiz) ohne JSON-Array."); }
             const jsonString = aiTextResponse.substring(startIndex, endIndex + 1);
             console.log("Extracted JSON string for parsing (Quiz):", jsonString.substring(0, 500) + "...");
             const quizQuestions = JSON.parse(jsonString);

            // --- UPDATED VALIDATION FOR MULTIPLE CORRECT ANSWERS ---
            if (!Array.isArray(quizQuestions)) { throw new Error("AI quiz response was not a valid JSON array."); }
            if (quizQuestions.length > 0) {
                 const firstQuestion = quizQuestions[0];
                 if (typeof firstQuestion.question !== 'string' ||
                     !Array.isArray(firstQuestion.options) ||
                     firstQuestion.options.length !== 4 ||
                     !Array.isArray(firstQuestion.correctAnswerIndices) || // Check if it's an array
                     firstQuestion.correctAnswerIndices.length === 0 || // Must have at least one correct answer
                     !firstQuestion.correctAnswerIndices.every(idx => typeof idx === 'number' && idx >= 0 && idx <= 3)) // Check if all indices are valid numbers
                 {
                      console.warn("Parsed quiz array elements might not have the correct structure: {question: string, options: string[4], correctAnswerIndices: number[]}.");
                      // Filter out invalid questions or throw error? For now, just warn.
                 }
            }
            // --- END OF UPDATED VALIDATION ---

            console.log(`Successfully parsed ${quizQuestions.length} quiz questions from AI response.`);
            return quizQuestions.slice(0, numberOfQuestions);

        } catch (parseError) {
            console.error("Failed to parse JSON from AI quiz response:", parseError);
            console.error("Raw response that failed parsing was:", aiTextResponse.substring(0, 1000) + "...");
            throw new Error(`Konnte das Quiz aus der KI-Antwort nicht korrekt extrahieren: ${parseError.message}`);
        }
    } catch (error) {
        console.error("Error calling Google Gemini API or processing its response (Quiz):", error);
        const message = error.status ? `${error.message} (Status: ${error.status})` : error.message;
        throw new Error(message || "Fehler bei der Kommunikation mit dem KI-Dienst für das Quiz.");
    }
}


// --- API Routes ---
function handleMulterError(err, req, res, next) { /* ... */ if (err instanceof multer.MulterError) { res.status(400).json({ error: `Fehler beim Datei-Upload: ${err.message}` }); } else if (err) { res.status(400).json({ error: err.message || "Fehler beim Datei-Upload." }); } else { next(); } }

app.post('/api/generate', upload.single('inputFile'), handleMulterError, async (req, res) => { /* ... (remains the same) ... */
    const inputType = req.body.inputType; let data; const maxCards = parseInt(req.body.maxCards) || 15; console.log(`[API /generate] Req: ${maxCards} cards, Type: ${inputType}`);
    try { if (inputType === 'text') { data = req.body.textData; if (!data?.trim()) throw new Error('Kein Text.'); } else if (inputType === 'file') { if (!req.file) throw new Error('Keine Datei.'); data = req.file; console.log(`File: ${data.originalname}`); } else if (inputType === 'url') { data = req.body.urlData; if (!data?.trim()) throw new Error('Keine URL.'); } else { return res.status(400).json({ error: 'Ungültiger Typ.' }); } const textContent = await extractText(inputType, data); const flashcards = await generateFlashcardsAI(textContent, maxCards); res.json({ flashcards: flashcards }); } catch (error) { console.error("Error in /api/generate:", error); res.status(500).json({ error: error.message || 'Serverfehler (Flashcards).' }); }
});

app.post('/api/generate-quiz', upload.single('inputFile'), handleMulterError, async (req, res) => { /* ... (remains the same) ... */
    const inputType = req.body.inputType; let data; const numQuestions = parseInt(req.body.numQuestions) || 5; console.log(`[API /generate-quiz] Req: ${numQuestions} questions, Type: ${inputType}`);
    try { if (inputType === 'text') { data = req.body.textData; if (!data?.trim()) throw new Error('Kein Text.'); } else if (inputType === 'file') { if (!req.file) throw new Error('Keine Datei.'); data = req.file; console.log(`File: ${data.originalname}`); } else if (inputType === 'url') { data = req.body.urlData; if (!data?.trim()) throw new Error('Keine URL.'); } else { return res.status(400).json({ error: 'Ungültiger Typ.' }); } const textContent = await extractText(inputType, data); const quizQuestions = await generateQuizAI(textContent, numQuestions); res.json({ quiz: quizQuestions }); } catch (error) { console.error("Error in /api/generate-quiz:", error); res.status(500).json({ error: error.message || 'Serverfehler (Quiz).' }); }
});

// --- Static File Serving & Catch-all Route --- (remains the same)
const frontendPath = path.resolve(__dirname, '..', 'Frontend');
console.log(`[STATIC] Base path for frontend: ${frontendPath}`);
if (fs.existsSync(frontendPath)) {
    console.log(`[STATIC] Directory ${frontendPath} exists. Configuring express.static.`);
    app.use(express.static(frontendPath));
    console.log(`[STATIC] Static file serving configured for ${frontendPath}`);
    app.get('*', (req, res) => {
        console.log(`[CATCH-ALL *] Request for path: ${req.path}`);
        if (req.path.startsWith('/api/')) { console.log(`[CATCH-ALL *] Unhandled API call to ${req.path}. Sending 404.`); return res.status(404).send('API endpoint not found.'); }
        const indexHtmlPath = path.join(frontendPath, 'index.html');
        console.log(`[CATCH-ALL *] Attempting to serve main HTML file: ${indexHtmlPath}`);
        res.sendFile(indexHtmlPath, (err) => {
            if (err) { console.error(`[CATCH-ALL *] Error sending file ${indexHtmlPath} for path ${req.path}:`, err); if (!res.headersSent) { if (err.code === 'ENOENT') { res.status(404).send(`Error: Main application HTML file (index.html) not found.`); } else { res.status(500).send("Internal server error."); } } }
            else { console.log(`[CATCH-ALL *] Successfully sent main HTML file for ${req.path}`); }
        });
    });
} else {
    console.error(`[STATIC] ERROR: Directory ${frontendPath} does not exist! Frontend will not be served.`);
    app.get('*', (req, res) => { res.status(500).send("Server configuration error: Frontend directory not found."); });
}

// --- Server Startup --- (remains the same)
app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
    if (!GEMINI_API_KEY) { console.warn("WARNUNG: GEMINI_API_KEY fehlt."); }
    else if (genAI && modelFlashcard && modelQuiz) { console.log("Gemini API Key loaded and clients initialized."); }
    else { console.error("Fehler bei der Initialisierung des Gemini Clients trotz vorhandenem API Key."); }
});
