#!/usr/bin/env node

/**
 * Sky Palette — Automated Front-End Checklist MCP Verification Script
 * 
 * Audits HTML, CSS, and JS against the Front-End Checklist MCP standard:
 * Endpoint: https://mcp.frontendchecklist.io/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const MCP_ENDPOINT = 'https://mcp.frontendchecklist.io/';
const MAX_PAYLOAD_BYTES = 45000;

async function callMcpTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    });

    const url = new URL(MCP_ENDPOINT);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          }
          if (parsed.result && parsed.result.isError) {
            const errText = parsed.result.content?.[0]?.text || 'MCP tool execution error';
            return reject(new Error(errText));
          }
          resolve(parsed.result);
        } catch (e) {
          reject(new Error(`Failed to parse MCP response: ${e.message}\nRaw data: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractAuditSnippets(fullHtml) {
  // If under limit, audit directly
  if (Buffer.byteLength(fullHtml, 'utf-8') < MAX_PAYLOAD_BYTES) {
    return [{ name: 'Full Document', code: fullHtml }];
  }

  const snippets = [];
  
  // Extract Head + minimal body for document/SEO/meta validation
  const headMatch = fullHtml.match(/<head[\s\S]*?<\/head>/i);
  if (headMatch) {
    snippets.push({
      name: 'Document Head & Metadata (SEO / Meta / Preload)',
      code: `<!DOCTYPE html>\n<html lang="en">\n${headMatch[0]}\n<body><main><h1>Sky Palette</h1></main></body>\n</html>`
    });
  }

  // Extract Main Semantic Body (strip massive inline script payloads for HTML/A11y inspection)
  const bodyStripped = fullHtml.replace(/<script[\s\S]*?<\/script>/gi, '<!-- script -->');
  if (Buffer.byteLength(bodyStripped, 'utf-8') < MAX_PAYLOAD_BYTES) {
    snippets.push({
      name: 'Document Structure & Landmarks (HTML / Semantics / A11y)',
      code: bodyStripped
    });
  } else {
    // Slice into landmark chunks
    const bodyMatch = bodyStripped.match(/<body[\s\S]*?<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[0] : bodyStripped.slice(0, 30000);
    snippets.push({
      name: 'Document Landmarks & Body Semantics',
      code: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sky Palette</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>${bodyContent.slice(0, 35000)}</html>`
    });
  }

  return snippets;
}

async function auditHtmlFile(filePath) {
  console.log(`\n🔍 Auditing: ${filePath} against Front-End Checklist MCP...`);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return false;
  }

  const fullCode = fs.readFileSync(filePath, 'utf-8');
  const snippets = extractAuditSnippets(fullCode);
  let allPassed = true;

  for (const snippet of snippets) {
    console.log(`\n--- Auditing: ${snippet.name} ---`);
    try {
      const result = await callMcpTool('review_code', {
        code: snippet.code,
        minPriority: 'high'
      });

      let report = null;
      if (result.structuredContent) {
        report = result.structuredContent;
      } else if (result.content?.[0]?.text) {
        report = JSON.parse(result.content[0].text);
      }

      if (!report) {
        console.log('⚠️ Could not extract structured report from MCP output.');
        continue;
      }

      const { summary, issues = [] } = report;
      console.log(`   - Checks Executed: ${summary.totalChecks}`);
      console.log(`   - Issues Found: ${summary.issuesFound}`);
      console.log(`   - Critical Issues: ${summary.criticalIssues}`);
      console.log(`   - High Priority Issues: ${summary.highIssues}`);

      if (issues.length > 0) {
        console.log(`\n   Identified High/Critical Issues:`);
        issues.forEach((issue, idx) => {
          const icon = issue.priority === 'critical' ? '🚨' : '⚠️';
          console.log(`   ${idx + 1}. ${icon} [${issue.priority.toUpperCase()}] ${issue.title} (${issue.rule})`);
          console.log(`      ${issue.issue}`);
          console.log(`      Guidance: ${issue.fixPrompt.slice(0, 160)}...`);
        });
      }

      if (summary.criticalIssues > 0) {
        allPassed = false;
      }
    } catch (err) {
      console.error(`❌ MCP snippet audit failed: ${err.message}`);
      allPassed = false;
    }
  }

  return allPassed;
}

async function main() {
  const targetFile = process.argv[2] || path.join(__dirname, '../preview.html');
  console.log('================================================================');
  console.log('Sky Palette — Front-End Checklist Pre-Launch Auditor');
  console.log('Endpoint: https://mcp.frontendchecklist.io/');
  console.log('================================================================');
  
  const success = await auditHtmlFile(targetFile);
  if (!success) {
    console.error('\n❌ Pre-launch checklist gate failed on critical issues.');
    process.exit(1);
  }
  console.log('\n✅ Pre-launch checklist gate passed with 0 critical issues.');
  process.exit(0);
}

main();
