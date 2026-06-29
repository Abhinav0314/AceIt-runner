import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import util from 'util';
import { createRequire } from 'module';

// Load .env if dotenv is available
try {
    const require = createRequire(import.meta.url);
    require('dotenv').config();
} catch (e) { /* dotenv optional in prod if env vars are set by host */ }

const execPromise = util.promisify(exec);

const RUNNER_SECRET = process.env.RUNNER_SECRET || null;

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const TEMP_DIR = path.join(os.tmpdir(), 'aceit-runner-temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Secret Auth Middleware ────────────────────────────────────────────────
const requireSecret = (req, res, next) => {
    if (!RUNNER_SECRET) return next(); // No secret set = dev mode (open)
    const provided = req.headers['x-runner-secret'];
    if (!provided || provided !== RUNNER_SECRET) {
        return res.status(401).json({ error: 'Unauthorized: invalid runner secret.' });
    }
    next();
};
// ──────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.send('AceIt Execution Runner is active.');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.post('/execute', requireSecret, async (req, res) => {
    const { code, language, input } = req.body;
    
    if (!code || !language) {
        return res.status(400).json({ error: 'Code and language are required' });
    }

    const uniqueId = crypto.randomBytes(16).toString('hex');
    let tempFile = '';
    let runCommand = '';

    try {
        if (language === 'javascript' || language === 'node') {
            tempFile = path.join(TEMP_DIR, `${uniqueId}.js`);
            const wrappedCode = `
${code}

// --- ACEIT RUNNER WRAPPER ---
const fs = require('fs');
const rawInput = fs.readFileSync(0, 'utf-8').trim();
if (rawInput) {
    const args = JSON.parse(rawInput);
    if (typeof solution !== 'function') {
        console.error("ReferenceError: function 'solution' is not defined.");
        process.exit(1);
    }
    const result = solution(...args);
    if (result !== undefined) {
        console.log(JSON.stringify(result));
    }
}
`;
            fs.writeFileSync(tempFile, wrappedCode);
            runCommand = `node ${tempFile}`;
        } else if (language === 'python' || language === 'python3') {
            tempFile = path.join(TEMP_DIR, `${uniqueId}.py`);
            const wrappedCode = `
${code}

# --- ACEIT RUNNER WRAPPER ---
import sys
import json
if __name__ == '__main__':
    raw_input = sys.stdin.read().strip()
    if raw_input:
        args = json.loads(raw_input)
        if 'solution' not in globals() or not callable(solution):
            print("NameError: name 'solution' is not defined", file=sys.stderr)
            sys.exit(1)
        result = solution(*args)
        if result is not None:
            print(json.dumps(result).replace(' ', ''))
`;
            fs.writeFileSync(tempFile, wrappedCode);
            runCommand = `python ${tempFile}`;
        } else if (language === 'cpp' || language === 'c++') {
            tempFile = path.join(TEMP_DIR, `${uniqueId}.cpp`);
            const outExe = path.join(TEMP_DIR, `${uniqueId}.exe`);
            fs.writeFileSync(tempFile, code);
            runCommand = `g++ ${tempFile} -o ${outExe} && ${outExe}`;
        } else if (language === 'java') {
            const isolatedDir = path.join(TEMP_DIR, uniqueId);
            fs.mkdirSync(isolatedDir, { recursive: true });
            tempFile = path.join(isolatedDir, 'Main.java');
            fs.writeFileSync(tempFile, code);
            runCommand = `cd ${isolatedDir} && javac Main.java && java Main`;
        } else {
            return res.status(400).json({ error: `Language ${language} is not supported on this runner.` });
        }

        const child = exec(runCommand, { timeout: 3000 }, (error, stdout, stderr) => {
            // Cleanup
            try {
                if (language === 'java') {
                   fs.rmSync(path.join(TEMP_DIR, uniqueId), { recursive: true, force: true });
                } else {
                   if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                   if (language === 'cpp' || language === 'c++') {
                       const outExe = path.join(TEMP_DIR, `${uniqueId}.exe`);
                       if (fs.existsSync(outExe)) fs.unlinkSync(outExe);
                   }
                }
            } catch (e) {
                console.error("Cleanup error:", e);
            }

            if (error) {
                if (error.killed) {
                    return res.json({ success: false, error: 'Execution Timed Out (Time Limit Exceeded)' });
                }
                
                // Clean the stderr to remove internal server paths
                let cleanError = stderr || error.message;
                // Replace absolute paths containing the uniqueId file with just "solution"
                const pathRegex = new RegExp(`[a-zA-Z0-9_/\\\\]+${uniqueId}\\.(js|py|cpp|java)`, 'g');
                cleanError = cleanError.replace(pathRegex, 'solution');
                
                return res.json({ success: false, error: cleanError, isGlobalError: true });
            }

            // Also check if stderr has content even without an error code (some languages warn)
            if (stderr && stderr.trim().length > 0) {
                 let cleanError = stderr;
                 const pathRegex = new RegExp(`[a-zA-Z0-9_/\\\\]+${uniqueId}\\.(js|py|cpp|java)`, 'g');
                 cleanError = cleanError.replace(pathRegex, 'solution');
                 return res.json({ success: false, error: cleanError, isGlobalError: true });
            }

            return res.json({ success: true, output: stdout });
        });

        if (input) {
            child.stdin.write(input);
            child.stdin.end();
        }

    } catch (err) {
        return res.status(500).json({ error: 'Server error during execution: ' + err.message });
    }
});

const PORT = process.env.PORT || 6060;
app.listen(PORT, () => {
    console.log(`🚀 Runner Server is listening on port ${PORT}`);
});
