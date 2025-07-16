// ==UserScript==
// @name         Walla Talkback Cleaner
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Clean spammy talkback comments
// @match        https://news.walla.co.il/item*
// @match        https://news.walla.co.il/item/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ---------------- CONFIG ---------------- */
    const LOG_LEVEL = 'summary'; // 'off' | 'summary' | 'verbose'
    const PREVIEW_LINES = 5;
    const MAX_CONSEC_BLANKS = 2;
    const INVISIBLE_CHAR_REGEX = /[\u115F\u1160\u200B-\u200F\uFEFF\u180E\u2060-\u2064\u00AD]/g; // update if new spam chars appear

    // Auto Hebrew label?
    const LOCALE_HE = document.documentElement && /^he\b/i.test(document.documentElement.lang || '');
    const TXT_SHOW_MORE = LOCALE_HE ? 'הצג עוד' : 'Show more';
    const TXT_SHOW_LESS = LOCALE_HE ? 'הצג פחות' : 'Show less';

    /* ---------------- STATE ---------------- */
    // Track nodes processed so we don't redo (WeakSet -> auto GC)
    const processedNodes = new WeakSet();

    // Stats for summary logging
    let totalNodesSeen = 0;
    let totalNodesProcessed = 0;
    let totalInvisRemoved = 0;
    let totalBlankRunsCollapsed = 0;
    let totalPreviewed = 0;

    /* ---------------- LOG HELPERS ---------------- */
    function log(...args) {
        if (LOG_LEVEL === 'off') return;
        console.log('[TB-Clean]', ...args);
    }
    function logVerbose(...args) {
        if (LOG_LEVEL !== 'verbose') return;
        console.log('[TB-Clean]', ...args);
    }
    function logGroupVerbose(label, fn) {
        if (LOG_LEVEL !== 'verbose') return fn();
        console.groupCollapsed('[TB-Clean]', label);
        try { fn(); } finally { console.groupEnd(); }
    }

    /* ---------------- CLEANING ---------------- */
    function countInvisibleChars(str) {
        const m = str.match(INVISIBLE_CHAR_REGEX);
        return m ? m.length : 0;
    }

    // Faster + safer blank collapse: operate on lines
    function collapseBlankRunsLines(lines, maxBlank) {
        let collapsedRuns = 0;
        const out = [];
        let blankCount = 0;
        for (const ln of lines) {
            if (ln.trim() === '') {
                blankCount++;
                if (blankCount <= maxBlank) out.push(''); // keep up to maxBlank
                else if (blankCount === maxBlank + 1) collapsedRuns++; // first drop increments
                // else drop silently
            } else {
                blankCount = 0;
                out.push(ln);
            }
        }
        return { lines: out, collapsedRuns };
    }

    function cleanComment(raw) {
        // Normalize newlines
        let txt = raw.replace(/\r\n?/g, '\n');

        const invisBefore = countInvisibleChars(txt);
        txt = txt.replace(INVISIBLE_CHAR_REGEX, '');

        // Split + collapse blank runs
        const rawLines = txt.split('\n');
        const { lines: collapsedLines, collapsedRuns } = collapseBlankRunsLines(rawLines, MAX_CONSEC_BLANKS);
        txt = collapsedLines.join('\n');

        // Trim leading/trailing blank lines
        txt = txt.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
        txt = txt.trimEnd(); // (keep leading text indentation in <pre> body? not needed)

        const linesAfter = txt.split('\n').length;
        return {
            cleaned: txt,
            invisBefore,
            collapsedRuns,
            linesBefore: rawLines.length,
            linesAfter,
            lenBefore: raw.length,
            lenAfter: txt.length,
        };
    }

    /* ---------------- UI ---------------- */
    function makeToggleButton(pre, shortText, fullText) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = TXT_SHOW_MORE;
        btn.className = 'tb-clean-toggle-btn';
        btn.style.display = 'block';
        btn.style.marginTop = '5px';
        btn.style.cursor = 'pointer';
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.color = '#0073e6';
        btn.style.fontWeight = 'bold';
        btn.style.padding = '0';
        btn.style.textDecoration = 'underline';

        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const expanded = pre.dataset.tbExpanded === '1';
            if (expanded) {
                pre.textContent = shortText;
                pre.dataset.tbExpanded = '0';
                btn.textContent = TXT_SHOW_MORE;
            } else {
                pre.textContent = fullText;
                pre.dataset.tbExpanded = '1';
                btn.textContent = TXT_SHOW_LESS;
            }
        });
        return btn;
    }

    /* ---------------- PER-NODE PROCESS ---------------- */
    function processPre(pre, idx) {
        totalNodesSeen++;

        if (processedNodes.has(pre)) {
            // Already processed; skip heavy work
            return;
        }

        processedNodes.add(pre);
        totalNodesProcessed++;

        const raw = pre.textContent || '';
        const stats = cleanComment(raw);
        const { cleaned, invisBefore, collapsedRuns, linesBefore, linesAfter, lenBefore, lenAfter } = stats;

        totalInvisRemoved += invisBefore;
        totalBlankRunsCollapsed += collapsedRuns;

        pre.dataset.tbFull = cleaned;

        let shortText = cleaned;
        let toggleAdded = false;
        if (linesAfter > PREVIEW_LINES) {
            shortText = cleaned.split('\n').slice(0, PREVIEW_LINES).join('\n') + '\n…';
            toggleAdded = true;
            totalPreviewed++;
        }
        pre.dataset.tbShort = shortText;
        pre.dataset.tbExpanded = '0';
        pre.textContent = toggleAdded ? shortText : cleaned;

        if (toggleAdded) {
            const btn = makeToggleButton(pre, shortText, cleaned);
            if (pre.parentNode) {
                pre.parentNode.insertBefore(btn, pre.nextSibling);
            }
        }

        // Per-comment verbose log
        logGroupVerbose(`Comment #${idx}`, () => {
            console.log('Element:', pre);
            console.log('Original length:', lenBefore, 'Cleaned length:', lenAfter);
            console.log('Original lines:', linesBefore, 'Cleaned lines:', linesAfter);
            console.log('Invisible chars removed:', invisBefore);
            console.log('Blank runs collapsed:', collapsedRuns);
            console.log('Toggle added:', toggleAdded);
        });
    }

    /* ---------------- BATCH ---------------- */
    function processAll() {
        const pres = document.querySelectorAll('pre.comment-item-text');
        let idx = 0;
        pres.forEach((pre) => processPre(pre, ++idx));

        if (LOG_LEVEL === 'summary') {
            // Use console.table for quick scan
            console.groupCollapsed('[TB-Clean] Summary');
            console.table([{
                url: location.href,
                nodesSeen: totalNodesSeen,
                nodesProcessed: totalNodesProcessed,
                invisRemoved: totalInvisRemoved,
                blankRunsCollapsed: totalBlankRunsCollapsed,
                previewed: totalPreviewed,
            }]);
            console.groupEnd();
        }
    }

    /* ---------------- OBSERVER ---------------- */
    let moTimer = null;
    const observer = new MutationObserver(() => {
        // Throttle to one batch per frame; if heavy loads, you can bump to setTimeout 100ms
        if (moTimer) return;
        moTimer = requestAnimationFrame(() => {
            moTimer = null;
            try {
                processAll();
            } catch (err) {
                console.error('[TB-Clean] Error in processAll (MO):', err);
            }
        });
    });

    function startObserver() {
        const root =
            document.querySelector('.talkback-list-wrapper') ||
            document.querySelector('.talkback-list') ||
            document.body;
        observer.observe(root, { childList: true, subtree: true });
        log('MutationObserver attached to', root);
    }

    /* ---------------- INIT ---------------- */
    function init() {
        if (!/https:\/\/news\.walla\.co\.il\/item/.test(location.href)) {
            log('Not an item page, exiting.');
            return;
        }
        log('Init on', location.href);

        try {
            processAll();
            startObserver();
        } catch (err) {
            console.error('[TB-Clean] Init error:', err);
        }
    }

    // Defer slightly to let page settle (reduces layout warnings)
    if ('requestIdleCallback' in window) {
        requestIdleCallback(init, { timeout: 1500 });
    } else {
        setTimeout(init, 800);
    }
})();
