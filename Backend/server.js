// Import necessary modules
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const pdf = require('pdf-parse');
const cheerio = require('cheerio');
const mammoth = require("mammoth");
const path = require('path'); // Ensure path is imported
const fs = require('fs'); // Import fs for checking directory existence

// Import Google Generative AI and dotenv
require('dotenv').config();
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// --- Configuration ---
const PORT = process.env.PORT || 3001; // Render provides the PORT env var
const app = express();

// Configure Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI, model;
if (!GEMINI_API_KEY) {
    console.warn("WARNUNG: GEMINI_API_KEY ist nicht definiert. Die KI-Funktionen sind deaktiviert.");
} else {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}


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
            $('script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"]').remove();
            let text = $('main').text() || $('article').text() || $('.content').text() || $('.post-content').text() || $('body').text();
            text = text.replace(/\s\s+/g, ' ').trim();
            console.log(`Extracted ${text.length} characters from URL.`);

            if (text.length === 0) {
                 console.warn("Extracted text from URL is empty. The page might use JavaScript rendering heavily or have no parsable text content.");
                 return Promise.resolve("[Kein Textinhalt von URL extrahiert. Möglicherweise JavaScript-Rendering oder keine Textinhalte.]");
            } else if (text.length > 0 && text.length < 150) {
                 console.warn(`Extracted text from URL is very short (${text.length} chars). Content might be incomplete or the page uses heavy JavaScript rendering.`);
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

// --- AI Flashcard Generation Function ---
async function generateFlashcardsAI(textContent, maxCards = 15) {
    if (!genAI || !model) {
        console.error("Gemini API client not initialized. Cannot generate cards.");
        throw new Error("KI-Dienst ist nicht verfügbar (API-Schlüssel fehlt?).");
    }
    console.log(`Calling Google Gemini API for flashcard generation (max ${maxCards} cards)...`);
    const numCards = Math.max(3, Math.min(25, maxCards));
    console.log(`Requesting ${numCards} cards from AI.`);

    if (!textContent || textContent.trim().length < 10) {
        console.log("Text content too short or empty, returning example cards.");
        return [{ front: "Kein Inhalt?", back: "Es wurde kein ausreichender Textinhalt für die Generierung gefunden oder der Inhalt war zu kurz." }];
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
        Erstelle maximal ${numCards} Lernkarten. Gib NUR das JSON-Array zurück, ohne einleitenden Text oder Erklärungen.
        Text: --- ${truncatedText} --- JSON-Array:
    `;
    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig, safetySettings,
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
        console.log("Raw AI text response sample:", aiTextResponse.substring(0, 500) + "...");
        try {
            const startIndex = aiTextResponse.indexOf('[');
            const endIndex = aiTextResponse.lastIndexOf(']');
            console.log(`Found startIndex '[' at: ${startIndex}`);
            console.log(`Found endIndex ']' at: ${endIndex}`);
            if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
                console.error("Could not find valid JSON array structure ([...]) in AI response.");
                throw new Error("Die KI-Antwort enthielt keine gültige Lernkartenstruktur.");
            }
            const jsonString = aiTextResponse.substring(startIndex, endIndex + 1);
            console.log("Extracted JSON string for parsing:", jsonString.substring(0, 500) + "...");
            const flashcards = JSON.parse(jsonString);
            if (!Array.isArray(flashcards)) {
                console.error("Parsed result is not an array.");
                throw new Error("AI response was not a valid JSON array after parsing.");
            }
            if (flashcards.length > 0 && (typeof flashcards[0].front !== 'string' || typeof flashcards[0].back !== 'string')) {
                 console.warn("Parsed array elements might not have the correct {front: string, back: string} structure.");
            }
            console.log(`Successfully parsed ${flashcards.length} flashcards from AI response.`);
            return flashcards.slice(0, numCards);
        } catch (parseError) {
            console.error("Failed to parse JSON from AI response:", parseError);
            console.error("Raw response that failed parsing was:", aiTextResponse.substring(0, 1000) + "...");
            throw new Error(`Konnte die Lernkarten aus der KI-Antwort nicht korrekt extrahieren. Möglicherweise ungültiges JSON von der KI: ${parseError.message}`);
        }
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
  } else { next(); }
}

app.post('/api/generate', upload.single('inputFile'), handleMulterError, async (req, res) => {
    const inputType = req.body.inputType;
    let data;
    const maxCards = parseInt(req.body.maxCards) || 15;
    console.log(`Max cards requested by client: ${maxCards}`);
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
        } else {
            return res.status(400).json({ error: 'Ungültiger Eingabetyp spezifiziert.' });
        }
        const textContent = await extractText(inputType, data);
        const flashcards = await generateFlashcardsAI(textContent, maxCards);
        res.json({ flashcards: flashcards });
    } catch (error) {
        console.error("Error in /api/generate route:", error);
        res.status(500).json({ error: error.message || 'Interner Serverfehler beim Generieren der Lernkarten.' });
    }
});

// --- Static File Serving & Catch-all Route ---
const frontendPath = path.resolve(__dirname, '..', 'Frontend');
console.log(`[STATIC] Attempting to serve static files from: ${frontendPath}`);

if (fs.existsSync(frontendPath)) {
    console.log(`[STATIC] Directory ${frontendPath} exists. Configuring express.static.`);
    // Serve static assets (CSS, JS, images etc.) from the frontend directory
    app.use(express.static(frontendPath));
} else {
    console.error(`[STATIC] ERROR: Directory ${frontendPath} not found! Static files (CSS, etc.) will not be served.`);
}

// Explicitly serve flashcard_app_german.html for the root path
app.get('/', (req, res) => {
  console.log(`[ROUTE /] Request received for root path.`);
  const htmlFilePath = path.join(frontendPath, 'flashcard_app_german.html');
  console.log(`[ROUTE /] Attempting to send file: ${htmlFilePath}`);
  res.sendFile(htmlFilePath, (err) => {
    if (err) {
      console.error(`[ROUTE /] Error sending file ${htmlFilePath}:`, err);
      if (!res.headersSent) { // Check if headers were already sent
          if (err.code === 'ENOENT') {
               res.status(404).send(`Haupt-HTML-Datei nicht gefunden unter ${htmlFilePath}.`);
          } else {
               res.status(500).send("Interner Serverfehler beim Laden der Anwendung.");
          }
      }
    } else {
      console.log(`[ROUTE /] Successfully sent file: ${htmlFilePath}`);
    }
  });
});

// Catch-all route for any other GET request.
// This should serve your main HTML file to support client-side routing (if you add it later)
// or to handle direct access to non-API paths.
// IMPORTANT: This must be one of the LAST routes.
app.get('*', (req, res) => {
  console.log(`[CATCH-ALL *] Route triggered for path: ${req.path}`);
  // If the request is for an API path but wasn't caught by other API handlers,
  // it shouldn't serve HTML. Check if it's an API-like path.
  if (req.path.startsWith('/api/')) {
    console.log(`[CATCH-ALL *] Path ${req.path} looks like an API call but was not handled. Sending 404.`);
    return res.status(404).send(`API-Endpunkt nicht gefunden: ${req.path}`);
  }

  const htmlFilePath = path.join(frontendPath, 'flashcard_app_german.html');
  console.log(`[CATCH-ALL *] Attempting to send main HTML file: ${htmlFilePath}`);
  res.sendFile(htmlFilePath, (err) => {
    if (err) {
      console.error(`[CATCH-ALL *] Error sending file ${htmlFilePath} for path ${req.path}:`, err);
      if (!res.headersSent) {
          // It's a catch-all, so if the main HTML file itself is missing, that's a server config issue.
          // Otherwise, for other paths, it's a client-side 404.
          if (err.code === 'ENOENT') {
              res.status(500).send("Fehler: Hauptanwendungsdatei nicht gefunden auf dem Server.");
          } else {
              res.status(500).send("Interner Serverfehler beim Laden der Ressource.");
          }
      }
    } else {
      console.log(`[CATCH-ALL *] Successfully sent main HTML file for ${req.path}`);
    }
  });
});

// --- Server Startup ---
app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
    if (!GEMINI_API_KEY) { // Check if GEMINI_API_KEY was loaded
         console.warn("WARNUNG: GEMINI_API_KEY nicht gefunden. Die KI-Generierung ist möglicherweise deaktiviert oder schlägt fehl.");
     } else {
         console.log("Gemini API Key loaded successfully.");
     }
});
