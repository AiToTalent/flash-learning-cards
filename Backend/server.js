// Import necessary modules
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const pdf = require('pdf-parse');
const cheerio = require('cheerio');
const mammoth = require("mammoth");

// Import Google Generative AI and dotenv
require('dotenv').config();
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const app = express();

// Configure Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY is not defined in your .env file.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Reverted to 1.5-flash for stability, can change back if needed

const generationConfig = {
    temperature: 0.7,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
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

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        console.log(`File filter received file: ${file.originalname}, mimetype: ${file.mimetype}`);
        const allowedTypes = [
            'text/plain',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            console.warn(`Rejected file type: ${file.mimetype}`);
            cb(new Error(`Ungültiger Dateityp: ${file.mimetype}. Erlaubt sind TXT, PDF, DOCX.`), false);
        }
    }
});

// --- Text Extraction Function ---

/**
 * Extracts text content from text, txt, pdf, docx files, and URLs.
 * @param {string} inputType - 'text', 'file', or 'url'
 * @param {any} data - The input data (string, file object from multer, or URL string)
 * @returns {Promise<string>} - A promise resolving to the extracted text content.
 */
async function extractText(inputType, data) {
    console.log(`Attempting to extract text from type: ${inputType}`);

    if (inputType === 'text') {
        return Promise.resolve(data || '');
    } else if (inputType === 'file' && data && data.buffer) {
        const fileBuffer = data.buffer;
        const mimetype = data.mimetype;
        console.log(`Processing file with mimetype: ${mimetype}`);

        if (mimetype === 'text/plain') {
            try {
                const text = fileBuffer.toString('utf-8');
                console.log(`Extracted ${text.length} characters from TXT file.`);
                return Promise.resolve(text);
            } catch (e) {
                console.error("Error reading TXT file:", e);
                return Promise.reject(new Error("Konnte die Textdatei nicht lesen."));
            }
        } else if (mimetype === 'application/pdf') {
            try {
                console.log("Parsing PDF file...");
                const pdfData = await pdf(fileBuffer);
                console.log(`Extracted ${pdfData.text.length} characters from PDF file.`);
                return Promise.resolve(pdfData.text);
            } catch (e) {
                console.error("Error parsing PDF file:", e);
                return Promise.reject(new Error("Konnte die PDF-Datei nicht verarbeiten. Ist sie beschädigt oder passwortgeschützt?"));
            }
        } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            try {
                console.log("Parsing DOCX file...");
                const result = await mammoth.extractRawText({ buffer: fileBuffer });
                const text = result.value;
                result.messages.forEach(message => console.log(`Mammoth message (${message.type}): ${message.message}`));
                console.log(`Extracted ${text.length} characters from DOCX file.`);
                return Promise.resolve(text);
            } catch (e) {
                 console.error("Error parsing DOCX file:", e);
                 return Promise.reject(new Error("Konnte die DOCX-Datei nicht verarbeiten. Ist sie beschädigt?"));
            }
        } else {
            console.warn(`Unsupported file type for extraction: ${mimetype}`);
            return Promise.reject(new Error(`Nicht unterstützter Dateityp für die Textextraktion: ${mimetype}`));
        }
    } else if (inputType === 'url') {
        const url = data;
        console.log(`Fetching content from URL: ${url}`);
        try {
            if (!url || !url.startsWith('http')) {
                throw new Error("Ungültige URL angegeben.");
            }
             if (/\.(jpg|jpeg|png|gif|mp3|mp4|zip|exe|dmg)$/i.test(url)) {
                 console.log(`URL seems to point to a binary file, skipping: ${url}`);
                 return Promise.resolve(`[Inhalt von URL nicht extrahiert: Vermutlich Binärdatei (${url})]`);
             }

            const response = await axios.get(url, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                 validateStatus: function (status) {
                    return status >= 200 && status < 600;
                 }
            });

            const contentType = response.headers['content-type'];
            console.log(`URL response status: ${response.status}, Content-Type: ${contentType}`);

            if (response.status >= 400) {
                 throw new Error(`Fehler beim Abrufen der URL: Status ${response.status}`);
            }

            if (!contentType || !contentType.toLowerCase().includes('html')) {
                console.log(`Content type is not HTML (${contentType}), skipping text extraction.`);
                if (contentType && contentType.toLowerCase().includes('text/plain') && typeof response.data === 'string') {
                    return Promise.resolve(response.data.substring(0, 5000));
                }
                return Promise.resolve(`[Inhalt von URL nicht extrahiert: Kein HTML (${contentType})]`);
            }

            const htmlContent = response.data;
            const $ = cheerio.load(htmlContent);
            $('script, style, noscript, iframe, header, footer, nav').remove();
            let text = $('main').text() || $('article').text() || $('body').text();
            text = text.replace(/\s\s+/g, ' ').trim();
            console.log(`Extracted ${text.length} characters from URL.`);
            if (text.length === 0) {
                 console.warn("Extracted text from URL is empty. The page might use JavaScript rendering heavily.");
                 return Promise.resolve("[Kein Textinhalt von URL extrahiert. Möglicherweise JavaScript-Rendering erforderlich.]");
            }
            return Promise.resolve(text);

        } catch (error) {
            console.error(`Error processing URL ${url}:`, error.message);
            if (error.code === 'ECONNABORTED') {
                 return Promise.reject(new Error('Fehler beim Abrufen der URL: Zeitüberschreitung (Timeout).'));
            } else if (error.response) {
                 return Promise.reject(new Error(`Fehler beim Abrufen der URL: Server antwortete mit Status ${error.response.status}`));
            } else if (error.request) {
                 return Promise.reject(new Error('Fehler beim Abrufen der URL: Keine Antwort vom Server erhalten (Netzwerkproblem?).'));
            } else {
                 return Promise.reject(new Error(`Fehler beim Verarbeiten der URL: ${error.message}`));
            }
        }
    } else {
        return Promise.reject(new Error('Invalid input type or data for text extraction'));
    }
}


/**
 * Generates flashcards using the Google Gemini API.
 * @param {string} textContent - The text to generate flashcards from.
 * @returns {Promise<Array<object>>} - A promise resolving to an array of flashcard objects.
 */
async function generateFlashcardsAI(textContent) {
    console.log("Calling Google Gemini API for flashcard generation...");

    if (!textContent || textContent.trim().length < 10) {
        console.log("Text content too short or empty, returning example cards.");
        return [{ front: "Kein Inhalt?", back: "Es wurde kein ausreichender Textinhalt für die Generierung gefunden." }];
    }

    const MAX_TEXT_LENGTH = 25000;
    const truncatedText = textContent.substring(0, MAX_TEXT_LENGTH);
    if(textContent.length > MAX_TEXT_LENGTH) {
        console.warn(`Text content truncated to ${MAX_TEXT_LENGTH} characters for API call.`);
    }

    const prompt = `
        Erstelle Lernkarten (Flashcards) basierend auf dem folgenden Text.
        Jede Lernkarte sollte eine klare Frage (front) und eine prägnante Antwort (back) haben, die direkt aus dem Text abgeleitet sind oder diesen zusammenfassen.
        Gib das Ergebnis ausschließlich als JSON-Array zurück, wobei jedes Objekt im Array eine Lernkarte darstellt und die Struktur {"front": "Frage hier", "back": "Antwort hier"} hat.
        WICHTIG: Die Werte für "front" und "back" müssen gültige JSON-Strings sein und dürfen keine unmaskierten Zeilenumbrüche enthalten. Sie sollten als einzelne Textzeile formatiert sein.
        Erstelle maximal 15 Lernkarten. Gib NUR das JSON-Array zurück, ohne einleitenden Text oder Erklärungen.

        Text:
        ---
        ${truncatedText}
        ---

        JSON-Array:
    `;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig,
            safetySettings,
        });

        const response = result.response;
        console.log("Gemini API response received.");

         if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
             const blockReason = response?.promptFeedback?.blockReason;
             const finishReason = response?.candidates?.[0]?.finishReason;
             console.warn(`Gemini response blocked or empty. Block Reason: ${blockReason}, Finish Reason: ${finishReason}`);
             throw new Error(`Keine gültige Antwort von der KI erhalten.${blockReason ? ` Grund: ${blockReason}` : ''}${finishReason ? ` Status: ${finishReason}` : ''}`);
         }

        const aiTextResponse = response.candidates[0].content.parts[0].text;
        console.log("Raw AI text response sample:", aiTextResponse.substring(0, 500) + "..."); // Log more of the response

        // --- ADDED LOGGING FOR INDEXES ---
        // Attempt to parse the JSON response from the AI
        try {
             // More robust cleaning: Find the JSON array within the response
             const startIndex = aiTextResponse.indexOf('[');
             const endIndex = aiTextResponse.lastIndexOf(']');
             // Log the found indexes
             console.log(`Found startIndex '[' at: ${startIndex}`);
             console.log(`Found endIndex ']' at: ${endIndex}`);

             if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
                 console.error("Could not find valid JSON array structure ([...]) in AI response. Check startIndex and endIndex values above.");
                 throw new Error("Die KI-Antwort enthielt keine gültige Lernkartenstruktur.");
             }

             // Extract the potential JSON string
             const jsonString = aiTextResponse.substring(startIndex, endIndex + 1);
             console.log("Extracted JSON string for parsing:", jsonString.substring(0, 500) + "..."); // Log more of the extracted string

            // Parse the extracted string
            const flashcards = JSON.parse(jsonString);
            if (!Array.isArray(flashcards)) {
                 console.error("Parsed result is not an array.");
                 throw new Error("AI response was not a valid JSON array after parsing.");
             }
             if (flashcards.length > 0 && (typeof flashcards[0].front !== 'string' || typeof flashcards[0].back !== 'string')) {
                  console.warn("Parsed array elements might not have the correct {front: string, back: string} structure.");
             }
            console.log(`Successfully parsed ${flashcards.length} flashcards from AI response.`);
            return flashcards;
        } catch (parseError) {
            console.error("Failed to parse JSON from AI response:", parseError);
            console.error("Raw response that failed parsing was:", aiTextResponse.substring(0, 1000) + "..."); // Log even more
            throw new Error(`Konnte die Lernkarten aus der KI-Antwort nicht korrekt extrahieren. Möglicherweise ungültiges JSON von der KI: ${parseError.message}`);
        }
        // --- END OF ADDED LOGGING ---
    } catch (error) {
        console.error("Error calling Google Gemini API or processing its response:", error);
        const message = error.status ? `${error.message} (Status: ${error.status})` : error.message;
        throw new Error(message || "Fehler bei der Kommunikation mit dem KI-Dienst.");
    }
}


// --- API Routes ---

function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    console.error("Multer error:", err);
    res.status(400).json({ error: `Fehler beim Datei-Upload: ${err.message}` });
  } else if (err) {
     console.error("File filter error:", err);
     res.status(400).json({ error: err.message || "Fehler beim Datei-Upload." });
  } else {
    next();
  }
}

app.post('/api/generate', upload.single('inputFile'), handleMulterError, async (req, res) => {
    const inputType = req.body.inputType;
    let data;

    console.log(`Received request for input type: ${inputType}`);
    try {
        if (inputType === 'text') {
            data = req.body.textData;
             if (!data || data.trim() === '') throw new Error('Kein Textinhalt übermittelt.');
        } else if (inputType === 'file') {
            if (!req.file) throw new Error('Keine Datei hochgeladen oder Datei wurde abgelehnt.');
            data = req.file;
            console.log(`Processing uploaded file: ${data.originalname} (${data.size} bytes)`);
        } else if (inputType === 'url') {
            data = req.body.urlData;
             if (!data || data.trim() === '') throw new Error('Keine URL übermittelt.');
             // Basic URL validation could be added here
        } else {
            return res.status(400).json({ error: 'Ungültiger Eingabetyp spezifiziert.' });
        }

        // 1. Extract text content (Handles TXT, PDF, DOCX, URL)
        const textContent = await extractText(inputType, data);

        // 2. Generate flashcards using AI
        const flashcards = await generateFlashcardsAI(textContent);

        // 3. Send the generated flashcards back to the frontend
        res.json({ flashcards: flashcards });

    } catch (error) {
        console.error("Error in /api/generate route:", error);
        res.status(500).json({ error: error.message || 'Interner Serverfehler beim Generieren der Lernkarten.' });
    }
});


const path = require('path');

// Statischen Ordner für das Frontend bereitstellen
app.use(express.static(path.join(__dirname, '..', 'Frontend')));

// Bei Aufruf der Startseite automatisch flashcard_app_german.html liefern
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'Frontend', 'flashcard_app_german.html'));
});

// --- Server Startup ---
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
         console.warn("WARNUNG: GEMINI_API_KEY nicht gefunden. Die KI-Generierung wird fehlschlagen.");
     } else {
         console.log("Gemini API Key loaded successfully.");
     }
});
