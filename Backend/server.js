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
let genAI, modelFlashcard, modelQuiz; // Separate models if needed, or use the same
if (!GEMINI_API_KEY) {
    console.warn("WARNUNG: GEMINI_API_KEY ist nicht definiert. Die KI-Funktionen sind deaktiviert.");
} else {
    try {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        // Use a capable model for both tasks, e.g., 1.5 Flash or Pro
        modelFlashcard = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        modelQuiz = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Can use the same or different
        console.log("Gemini API Client initialisiert.");
    } catch (e) {
        console.error("Fehler bei der Initialisierung des Gemini API Clients:", e);
        genAI = null; modelFlashcard = null; modelQuiz = null; // Ensure they are null on error
    }
}

const generationConfig = {
    temperature: 0.6, // Slightly lower temperature for more focused quiz questions
    topK: 1,
    topP: 1,
    maxOutputTokens: 4096, // Allow potentially longer JSON output for quizzes
};
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

// Multer configuration (remains the same)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        console.log(`File filter received file: ${file.originalname}, mimetype: ${file.mimetype}`);
        const allowedTypes = ['text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (allowedTypes.includes(file.mimetype)) { cb(null, true); }
        else { cb(new Error(`Ungültiger Dateityp: ${file.mimetype}. Erlaubt sind TXT, PDF, DOCX.`), false); }
    }
});

// --- Text Extraction Function --- (remains the same)
async function extractText(inputType, data) {
    console.log(`Attempting to extract text from type: ${inputType}`);
    if (inputType === 'text') { return Promise.resolve(data || ''); }
    else if (inputType === 'file' && data && data.buffer) { /* ... (TXT, PDF, DOCX extraction logic as before) ... */
        const fileBuffer = data.buffer;
        const mimetype = data.mimetype;
        console.log(`Processing file with mimetype: ${mimetype}`);
        if (mimetype === 'text/plain') { try { const text = fileBuffer.toString('utf-8'); console.log(`Extracted ${text.length} characters from TXT file.`); return Promise.resolve(text); } catch (e) { console.error("Error reading TXT file:", e); return Promise.reject(new Error("Konnte die Textdatei nicht lesen.")); } }
        else if (mimetype === 'application/pdf') { try { console.log("Parsing PDF file..."); const pdfData = await pdf(fileBuffer); console.log(`Extracted ${pdfData.text.length} characters from PDF file.`); return Promise.resolve(pdfData.text); } catch (e) { console.error("Error parsing PDF file:", e); return Promise.reject(new Error("Konnte die PDF-Datei nicht verarbeiten. Ist sie beschädigt oder passwortgeschützt?")); } }
        else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { try { console.log("Parsing DOCX file..."); const result = await mammoth.extractRawText({ buffer: fileBuffer }); const text = result.value; result.messages.forEach(message => console.log(`Mammoth message (${message.type}): ${message.message}`)); console.log(`Extracted ${text.length} characters from DOCX file.`); return Promise.resolve(text); } catch (e) { console.error("Error parsing DOCX file:", e); return Promise.reject(new Error("Konnte die DOCX-Datei nicht verarbeiten. Ist sie beschädigt?")); } }
        else { console.warn(`Unsupported file type for extraction: ${mimetype}`); return Promise.reject(new Error(`Nicht unterstützter Dateityp für die Textextraktion: ${mimetype}`)); }
    } else if (inputType === 'url') { /* ... (URL extraction logic as before) ... */
        const url = data;
        console.log(`Fetching content from URL: ${url}`);
        try {
            if (!url || !url.startsWith('http')) { throw new Error("Ungültige URL angegeben."); }
            if (/\.(jpg|jpeg|png|gif|mp3|mp4|zip|exe|dmg)$/i.test(url)) { console.log(`URL seems to point to a binary file, skipping: ${url}`); return Promise.resolve(`[Inhalt von URL nicht extrahiert: Vermutlich Binärdatei (${url})]`); }
            const response = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }, validateStatus: (status) => status >= 200 && status < 600 });
            const contentType = response.headers['content-type'];
            console.log(`URL response status: ${response.status}, Content-Type: ${contentType}`);
            if (response.status >= 400) { throw new Error(`Fehler beim Abrufen der URL: Status ${response.status}`); }
            if (!contentType || !contentType.toLowerCase().includes('html')) { console.log(`Content type is not HTML (${contentType}), skipping text extraction.`); if (contentType && contentType.toLowerCase().includes('text/plain') && typeof response.data === 'string') { return Promise.resolve(response.data.substring(0, 5000)); } return Promise.resolve(`[Inhalt von URL nicht extrahiert: Kein HTML (${contentType})]`); }
            const htmlContent = response.data; const $ = cheerio.load(htmlContent); $('script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"]').remove(); let text = $('main').text() || $('article').text() || $('.content').text() || $('.post-content').text() || $('body').text(); text = text.replace(/\s\s+/g, ' ').trim(); console.log(`Extracted ${text.length} characters from URL.`);
            if (text.length === 0) { console.warn("Extracted text from URL is empty."); return Promise.resolve("[Kein Textinhalt von URL extrahiert.]"); }
            else if (text.length > 0 && text.length < 150) { console.warn(`Extracted text from URL is very short (${text.length} chars).`); }
            return Promise.resolve(text);
        } catch (error) { console.error(`Error processing URL ${url}:`, error.message); if (error.code === 'ECONNABORTED') { return Promise.reject(new Error('Fehler beim Abrufen der URL: Zeitüberschreitung (Timeout).')); } else if (error.response) { return Promise.reject(new Error(`Fehler beim Abrufen der URL: Server antwortete mit Status ${error.response.status}`)); } else if (error.request) { return Promise.reject(new Error('Fehler beim Abrufen der URL: Keine Antwort vom Server erhalten (Netzwerkproblem?).')); } else { return Promise.reject(new Error(`Fehler beim Verarbeiten der URL: ${error.message}`)); } }
    } else { return Promise.reject(new Error('Invalid input type or data for text extraction')); }
}

// --- AI Flashcard Generation Function --- (remains the same)
async function generateFlashcardsAI(textContent, maxCards = 15) {
    if (!genAI || !modelFlashcard) { throw new Error("KI-Dienst (Flashcard) ist nicht verfügbar."); }
    console.log(`Calling Gemini API for flashcard generation (max ${maxCards} cards)...`);
    const numCards = Math.max(3, Math.min(25, maxCards));
    if (!textContent || textContent.trim().length < 10) { return [{ front: "Kein Inhalt?", back: "Textinhalt zu kurz." }]; }
    const MAX_TEXT_LENGTH = 25000; const truncatedText = textContent.substring(0, MAX_TEXT_LENGTH);
    if(textContent.length > MAX_TEXT_LENGTH) { console.warn(`Text content truncated to ${MAX_TEXT_LENGTH} characters.`); }
    const prompt = `Erstelle Lernkarten (Flashcards) basierend auf dem folgenden Text. Jede Lernkarte sollte eine klare Frage (front) und eine prägnante Antwort (back) haben. Gib das Ergebnis ausschließlich als JSON-Array zurück, mit der Struktur {"front": "Frage hier", "back": "Antwort hier"}. WICHTIG: Die Werte für "front" und "back" müssen gültige JSON-Strings ohne unmaskierte Zeilenumbrüche sein. Erstelle maximal ${numCards} Lernkarten. Gib NUR das JSON-Array zurück. Text: --- ${truncatedText} --- JSON-Array:`;
    try {
        const result = await modelFlashcard.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig, safetySettings });
        const response = result.response; console.log("Gemini API response received (Flashcards).");
        if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content) { const blockReason = response?.promptFeedback?.blockReason; const finishReason = response?.candidates?.[0]?.finishReason; console.warn(`Gemini response blocked/empty. Block: ${blockReason}, Finish: ${finishReason}`); throw new Error(`Keine gültige Antwort von der KI erhalten.${blockReason ? ` Grund: ${blockReason}` : ''}${finishReason ? ` Status: ${finishReason}` : ''}`); }
        const aiTextResponse = response.candidates[0].content.parts[0].text; console.log("Raw AI text response sample (Flashcards):", aiTextResponse.substring(0, 200) + "...");
        try {
            const startIndex = aiTextResponse.indexOf('['); const endIndex = aiTextResponse.lastIndexOf(']'); console.log(`Found startIndex '[' at: ${startIndex}`); console.log(`Found endIndex ']' at: ${endIndex}`);
            if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) { console.error("Could not find valid JSON array structure ([...])."); throw new Error("KI-Antwort enthielt keine gültige Lernkartenstruktur."); }
            const jsonString = aiTextResponse.substring(startIndex, endIndex + 1); console.log("Extracted JSON string for parsing (Flashcards):", jsonString.substring(0, 200) + "...");
            const flashcards = JSON.parse(jsonString); if (!Array.isArray(flashcards)) { console.error("Parsed result is not an array."); throw new Error("AI response was not a valid JSON array."); }
            if (flashcards.length > 0 && (typeof flashcards[0].front !== 'string' || typeof flashcards[0].back !== 'string')) { console.warn("Parsed array elements might not have correct {front, back} structure."); }
            console.log(`Successfully parsed ${flashcards.length} flashcards.`); return flashcards.slice(0, numCards);
        } catch (parseError) { console.error("Failed to parse JSON from AI response (Flashcards):", parseError); console.error("Raw response:", aiTextResponse.substring(0, 1000) + "..."); throw new Error(`Konnte Lernkarten nicht extrahieren: ${parseError.message}`); }
    } catch (error) { console.error("Error calling Gemini API (Flashcards):", error); const message = error.status ? `${error.message} (Status: ${error.status})` : error.message; throw new Error(message || "Fehler bei KI-Kommunikation."); }
}


// --- NEW: AI Quiz Generation Function ---
/**
 * Generates multiple-choice quiz questions using the Google Gemini API.
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

    // Ensure numQuestions is within reasonable bounds
    const numberOfQuestions = Math.max(3, Math.min(15, numQuestions));
    console.log(`Requesting ${numberOfQuestions} quiz questions from AI.`);

    if (!textContent || textContent.trim().length < 50) { // Need a bit more text for good questions
        console.log("Text content too short for quiz generation.");
        // Return an empty array or a specific message? Empty array might be cleaner for frontend.
        return [];
        // Or: throw new Error("Textinhalt zu kurz für die Quiz-Generierung.");
    }

    // Limit text length sent to API
    const MAX_TEXT_LENGTH = 25000;
    const truncatedText = textContent.substring(0, MAX_TEXT_LENGTH);
    if(textContent.length > MAX_TEXT_LENGTH) {
        console.warn(`Text content truncated to ${MAX_TEXT_LENGTH} characters for quiz API call.`);
    }

    // Detailed prompt for generating high-quality MCQs
    const prompt = `
        Erstelle basierend auf dem folgenden Text ein Multiple-Choice-Quiz.
        Zielgruppe: Lernende, die den Inhalt des Textes verstehen und überprüfen möchten.
        Anforderungen:
        1.  Generiere genau ${numberOfQuestions} Fragen.
        2.  Jede Frage muss sich klar auf eine wichtige Information oder ein Schlüsselkonzept im Text beziehen.
        3.  Formuliere die Fragen klar und eindeutig. Vermeide Mehrdeutigkeiten.
        4.  Erstelle für jede Frage genau 4 Antwortoptionen (ein Array von Strings).
        5.  Nur EINE der vier Optionen darf korrekt sein.
        6.  Die falschen Antwortoptionen (Distraktoren) müssen plausibel klingen, aber eindeutig falsch sein und sich idealerweise auf verwandte, aber inkorrekte Konzepte aus dem Text oder dem allgemeinen Themenbereich beziehen. Vermeide offensichtlich unsinnige Optionen.
        7.  Gib das Ergebnis ausschließlich als JSON-Array zurück. Jedes Objekt im Array repräsentiert eine Frage und muss exakt die folgende Struktur haben:
            {
              "question": "Die Frage als String.",
              "options": ["Antwort A", "Antwort B", "Antwort C", "Antwort D"],
              "correctAnswerIndex": index_der_korrekten_antwort // (Zahl von 0 bis 3)
            }
        8.  Stelle sicher, dass das gesamte Ergebnis valides JSON ist. Die Strings für "question" und die "options" dürfen keine unmaskierten Zeilenumbrüche enthalten.

        Text:
        ---
        ${truncatedText}
        ---

        JSON-Array mit Quizfragen:
    `;

    try {
        // Use the quiz model instance if defined separately, otherwise fallback to flashcard model
        const activeModel = modelQuiz || modelFlashcard;
        if (!activeModel) throw new Error("Kein gültiges KI-Modell für Quiz verfügbar.");

        const result = await activeModel.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig, // Use the same config or define a specific one for quizzes
            safetySettings,
        });

        const response = result.response;
        console.log("Gemini API response received (Quiz).");

         if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
             const blockReason = response?.promptFeedback?.blockReason;
             const finishReason = response?.candidates?.[0]?.finishReason;
             console.warn(`Gemini response blocked/empty (Quiz). Block: ${blockReason}, Finish: ${finishReason}`);
             throw new Error(`Keine gültige Quiz-Antwort von der KI erhalten.${blockReason ? ` Grund: ${blockReason}` : ''}${finishReason ? ` Status: ${finishReason}` : ''}`);
         }

        const aiTextResponse = response.candidates[0].content.parts[0].text;
        console.log("Raw AI text response sample (Quiz):", aiTextResponse.substring(0, 500) + "...");

        // Attempt to parse the JSON response from the AI
        try {
             const startIndex = aiTextResponse.indexOf('[');
             const endIndex = aiTextResponse.lastIndexOf(']');
             console.log(`Found startIndex '[' at: ${startIndex} (Quiz)`);
             console.log(`Found endIndex ']' at: ${endIndex} (Quiz)`);

             if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
                 console.error("Could not find valid JSON array structure ([...]) in AI quiz response.");
                 throw new Error("Die KI-Antwort für das Quiz enthielt keine gültige JSON-Struktur.");
             }
             const jsonString = aiTextResponse.substring(startIndex, endIndex + 1);
             console.log("Extracted JSON string for parsing (Quiz):", jsonString.substring(0, 500) + "...");

            const quizQuestions = JSON.parse(jsonString);

            // Basic validation of the structure
            if (!Array.isArray(quizQuestions)) {
                 console.error("Parsed quiz result is not an array.");
                 throw new Error("AI quiz response was not a valid JSON array after parsing.");
            }
            if (quizQuestions.length > 0) {
                 const firstQuestion = quizQuestions[0];
                 if (typeof firstQuestion.question !== 'string' ||
                     !Array.isArray(firstQuestion.options) ||
                     firstQuestion.options.length !== 4 || // Expect exactly 4 options
                     typeof firstQuestion.correctAnswerIndex !== 'number' ||
                     firstQuestion.correctAnswerIndex < 0 ||
                     firstQuestion.correctAnswerIndex > 3)
                 {
                      console.warn("Parsed quiz array elements might not have the correct structure: {question: string, options: string[4], correctAnswerIndex: number(0-3)}.");
                      // Depending on strictness, you might throw an error or filter invalid questions
                 }
            }

            console.log(`Successfully parsed ${quizQuestions.length} quiz questions from AI response.`);
            // Return only the requested number of questions, even if AI generated more
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
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) { res.status(400).json({ error: `Fehler beim Datei-Upload: ${err.message}` }); }
  else if (err) { res.status(400).json({ error: err.message || "Fehler beim Datei-Upload." }); }
  else { next(); }
}

// Endpoint for Flashcards
app.post('/api/generate', upload.single('inputFile'), handleMulterError, async (req, res) => {
    const inputType = req.body.inputType;
    let data;
    const maxCards = parseInt(req.body.maxCards) || 15;
    console.log(`[API /generate] Max cards requested: ${maxCards}, Type: ${inputType}`);
    try {
        if (inputType === 'text') { data = req.body.textData; if (!data || data.trim() === '') throw new Error('Kein Textinhalt übermittelt.'); }
        else if (inputType === 'file') { if (!req.file) throw new Error('Keine Datei hochgeladen/abgelehnt.'); data = req.file; console.log(`Processing file: ${data.originalname}`); }
        else if (inputType === 'url') { data = req.body.urlData; if (!data || data.trim() === '') throw new Error('Keine URL übermittelt.'); }
        else { return res.status(400).json({ error: 'Ungültiger Eingabetyp.' }); }

        const textContent = await extractText(inputType, data);
        const flashcards = await generateFlashcardsAI(textContent, maxCards);
        res.json({ flashcards: flashcards });
    } catch (error) {
        console.error("Error in /api/generate route:", error);
        res.status(500).json({ error: error.message || 'Interner Serverfehler (Flashcards).' });
    }
});

// --- NEW: Endpoint for Quiz ---
app.post('/api/generate-quiz', upload.single('inputFile'), handleMulterError, async (req, res) => {
    const inputType = req.body.inputType;
    let data;
    // Quiz might have a different parameter for number of questions, e.g., 'numQuestions'
    const numQuestions = parseInt(req.body.numQuestions) || 5; // Default to 5 questions
    console.log(`[API /generate-quiz] Num questions requested: ${numQuestions}, Type: ${inputType}`);
    try {
        if (inputType === 'text') { data = req.body.textData; if (!data || data.trim() === '') throw new Error('Kein Textinhalt übermittelt.'); }
        else if (inputType === 'file') { if (!req.file) throw new Error('Keine Datei hochgeladen/abgelehnt.'); data = req.file; console.log(`Processing file: ${data.originalname}`); }
        else if (inputType === 'url') { data = req.body.urlData; if (!data || data.trim() === '') throw new Error('Keine URL übermittelt.'); }
        else { return res.status(400).json({ error: 'Ungültiger Eingabetyp.' }); }

        const textContent = await extractText(inputType, data);
        const quizQuestions = await generateQuizAI(textContent, numQuestions); // Call new AI function
        res.json({ quiz: quizQuestions }); // Send back quiz data under the key 'quiz'

    } catch (error) {
        console.error("Error in /api/generate-quiz route:", error);
        res.status(500).json({ error: error.message || 'Interner Serverfehler (Quiz).' });
    }
});


// --- Static File Serving & Catch-all Route --- (remains the same)
const frontendPath = path.resolve(__dirname, '..', 'Frontend');
console.log(`[STATIC] Attempting to serve static files from: ${frontendPath}`);
if (fs.existsSync(frontendPath)) {
    console.log(`[STATIC] Directory ${frontendPath} exists. Configuring express.static.`);
    app.use(express.static(frontendPath));
} else {
    console.error(`[STATIC] ERROR: Directory ${frontendPath} does not exist!`);
}
app.get('*', (req, res) => {
    console.log(`[CATCH-ALL *] Request for path: ${req.path}`);
    if (req.path.startsWith('/api/')) {
        console.log(`[CATCH-ALL *] Unhandled API call to ${req.path}. Sending 404.`);
        return res.status(404).send('API endpoint not found.');
    }
    const htmlFilePath = path.join(frontendPath, 'flashcard_app_german.html');
    console.log(`[CATCH-ALL *] Attempting to serve main HTML file: ${htmlFilePath}`);
    res.sendFile(htmlFilePath, (err) => {
        if (err) {
            console.error(`[CATCH-ALL *] Error sending file ${htmlFilePath}:`, err);
            if (!res.headersSent) {
                if (err.code === 'ENOENT') { res.status(404).send(`Error: Main application HTML file not found.`); }
                else { res.status(500).send("Internal server error."); }
            }
        } else { console.log(`[CATCH-ALL *] Successfully sent main HTML file for ${req.path}`); }
    });
});

// --- Server Startup --- (remains the same)
app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
    if (!GEMINI_API_KEY) { console.warn("WARNUNG: GEMINI_API_KEY fehlt."); }
    else if (genAI && modelFlashcard && modelQuiz) { console.log("Gemini API Key loaded and clients initialized."); }
    else { console.error("Fehler bei der Initialisierung des Gemini Clients trotz vorhandenem API Key."); }
});
