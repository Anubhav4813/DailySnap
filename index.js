require('dotenv').config();
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { TwitterApi } = require('twitter-api-v2');

// Debug helper function
function debugLog(message, data = null) {
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--debug')) {
    console.log(`[DEBUG] ${message}`);
    if (data) {
      console.log('[DEBUG] Data:', JSON.stringify(data, null, 2));
    }
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
const MIN_SUMMARY_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 280;
const MAX_RETRIES = 1;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
// Diversity (domain balancing) feature toggles
const DIVERSITY_ENABLED = process.env.DIVERSITY_ENABLED === '1' || process.env.DIVERSITY_ENABLED === 'true';
const DIVERSITY_PENALTY_WEIGHT = parseFloat(process.env.DIVERSITY_PENALTY_WEIGHT || '1.5');
const DIVERSITY_LOOKBACK = parseInt(process.env.DIVERSITY_LOOKBACK || '80', 10); // how many past links to consider
const BALANCED_SELECTION = process.env.BALANCED_SELECTION === '1' || process.env.BALANCED_SELECTION === 'true';
// Additional anti-dominance controls
const MAX_DOMAIN_SHARE = parseFloat(process.env.MAX_DOMAIN_SHARE || '0'); // 0 disables (e.g. 0.3 for 30%)
const DOMAIN_SHARE_LOOKBACK = parseInt(process.env.DOMAIN_SHARE_LOOKBACK || '150', 10); // posts inspected for share
const NO_CONSECUTIVE_DOMAIN = process.env.NO_CONSECUTIVE_DOMAIN === '1' || process.env.NO_CONSECUTIVE_DOMAIN === 'true';
const MIN_UNIQUE_DOMAINS_WINDOW = parseInt(process.env.MIN_UNIQUE_DOMAINS_WINDOW || '0', 10); // if >0 and unique < value, enforce new domain
// Prevent two tweets in a row from the same exact RSS feed URL (even if domain differs across feeds)
const NO_CONSECUTIVE_FEED = process.env.NO_CONSECUTIVE_FEED === '1' || process.env.NO_CONSECUTIVE_FEED === 'true';
// Strict round-robin mode: stateless rotation (time-slot based) if enabled
const ROUND_ROBIN_FEEDS = process.env.ROUND_ROBIN_FEEDS === '1' || process.env.ROUND_ROBIN_FEEDS === 'true';
// Minutes per rotation step (default 120 = every 2 hours). Each slot picks next feed deterministically.
const ROTATION_INTERVAL_MINUTES = parseInt(process.env.ROTATION_INTERVAL_MINUTES || '120', 10);
// Strict rotation: feed index = successful post count % feedCount, only that feed attempted.
const STRICT_ROTATION = process.env.STRICT_ROTATION === '1' || process.env.STRICT_ROTATION === 'true';
const STRICT_EXPANSION_WINDOWS = (process.env.STRICT_EXPANSION_WINDOWS || '2h,6h,24h').split(',');

const twitterClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET
});
const rwClient = twitterClient.readWrite;

const rssFeeds = [
  // Normal news
  "https://www.thehindu.com/news/national/feeder/default.rss",
  "https://indianexpress.com/section/india/feed/",
  "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms",
  // Business news
  "https://economictimes.indiatimes.com/rssfeeds/1977021501.cms",
  // Technology news
  "https://techcrunch.com/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://github.blog/feed/",
  "https://www.thehindu.com/sci-tech/technology/feeder/default.rss",
  "https://indianexpress.com/section/technology/feed/",
  // Science and tech
  "https://www.thehindu.com/sci-tech/feeder/default.rss",
  "https://www.indiatoday.in/rss/1206614",
  "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms",
  // Sports news
  "https://www.thehindu.com/sport/feeder/default.rss",
  "https://www.espncricinfo.com/rss/content/story/feeds/6.xml",
  // Bollywood
  "https://www.bollywoodhungama.com/rss/news.xml",
  // Environment
  "https://www.thehindu.com/sci-tech/energy-and-environment/feeder/default.rss",
];

// Optional: override or add feeds via external JSON (feeds.json) without code change
try {
  const externalFeedsPath = 'feeds.json';
  if (fs.existsSync(externalFeedsPath)) {
    const extra = JSON.parse(fs.readFileSync(externalFeedsPath, 'utf-8'));
    if (Array.isArray(extra) && extra.length) {
      console.log(`[INFO] Loaded ${extra.length} external feeds from feeds.json`);
      // Merge (avoid duplicates)
      for (const f of extra) {
        if (typeof f === 'string' && !rssFeeds.includes(f)) rssFeeds.push(f);
      }
    }
  }
} catch (e) {
  console.warn('[WARN] Could not load feeds.json:', e.message);
}

const parser = new Parser({
  customFields: {
    item: ['content:encoded', 'media:content']
  },
  // Provide default headers for parseURL fallback to improve success rates
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*'
    },
    timeout: 10000
  }
});

// (Feed health tracking removed)

// Fetch RSS with retry and fallback to parser.parseURL
async function fetchFeedWithRetry(feedUrl, retries = 2) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      debugLog(`Fetching feed (attempt ${attempt}): ${feedUrl}`);
      const response = await axios.get(feedUrl, { headers, timeout: 10000, maxRedirects: 5 });
      // Basic sanity check
      if (!response.data || String(response.data).length < 100) {
        throw new Error('Empty or too-small RSS response');
      }
  const feed = await parser.parseString(response.data);
      return feed.items || [];
    } catch (e) {
      lastErr = e;
      debugLog(`Primary fetch failed for ${feedUrl}, will try fallback parseURL if possible.`, { message: e.message });
      // Small jitter before fallback/next attempt
      await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 300)));
      try {
        const feed = await parser.parseURL(feedUrl);
        if (feed && feed.items && feed.items.length) {
          return feed.items;
        }
        throw new Error('parseURL returned no items');
      } catch (fallbackErr) {
        lastErr = fallbackErr;
        debugLog(`Fallback parseURL failed for ${feedUrl}`, { message: fallbackErr.message });
        // On next loop iteration, retry again (up to retries)
      }
    }
  }
  console.error(`❌ All attempts failed for feed: ${feedUrl} - ${lastErr ? lastErr.message : 'unknown error'}`);
  return [];
}
// (Diagnostics feature removed)

async function extractArticleContent(url) {
  try {
    // Minimal random delay for GitHub Actions (200ms to 800ms)
    const randomDelay = Math.floor(Math.random() * 600) + 200;
    await new Promise(resolve => setTimeout(resolve, randomDelay));
    
    // Enhanced headers for different sites
    let headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    };

    // Site-specific headers for better success rates
    if (url.includes('timesofindia.com')) {
      headers['Referer'] = 'https://www.google.com/';
    }
    
    const { data } = await axios.get(url, {
      headers,
      timeout: 15000, // Increased timeout for slower sites
      maxRedirects: 5,
      validateStatus: function (status) {
        return status < 500; // Accept anything less than 500
      }
    });

    // Check for successful response
    if (!data || data.length < 100) {
      console.warn(`[WARN] Empty or minimal response from ${url}`);
      return null;
    }

    const $ = cheerio.load(data);
    $('script, style, iframe, noscript, figure, .ad-container, .advertisement').remove();

    let content = '';

    if (url.includes('thehindu.com')) {
      content = $('[itemprop="articleBody"]').text().trim() ||
                $('.content').text().trim() ||
                $('article').text().trim();
    } else if (url.includes('indianexpress.com')) {
      content = $('.full-details, .editor-body, .story-details').text().trim() ||
                $('article').text().trim();
    } else if (url.includes('timesofindia.com')) {
      content = $('.Normal, .ga-headline, ._3YYSt').text().trim() ||
                $('article').text().trim();
    } else {
      content = $('article, .article-content, [itemprop="articleBody"], .content, .story-body').text().trim() ||
                $('body').text().trim();
    }

    // Clean up the content
    content = content.replace(/\s+/g, ' ').trim();
    
    if (content.length < 100) {
      console.warn(`[WARN] Content too short (${content.length} chars) from ${url}`);
      return null;
    }

    return content;
  } catch (error) {
    const errorCode = error.response?.status || 'unknown';
    const errorMsg = error.message || 'unknown error';
    
    // Log different error types with appropriate severity
    if (errorCode === 403) {
      console.warn(`[WARN] Access denied (403) for ${url} - site may be blocking requests`);
    } else if (errorCode === 404) {
      console.warn(`[WARN] Article not found (404) for ${url}`);
    } else if (errorCode === 429) {
      console.warn(`[WARN] Rate limited (429) for ${url} - too many requests`);
    } else {
      console.error(`[ERROR] Failed to extract content from ${url}: ${errorCode} - ${errorMsg}`);
    }
    
    return null;
  }
}

async function generateStrictLengthSummary(content) {
  try {
    const truncatedContent = content.substring(0, 10000);
    const prompt = {
      contents: [{
        parts: [{
          text: `Summarize this news article in exactly 260 characters (no less than 240, no more than 280).\nInclude key details: who, what, where, when, why.\nMaintain complete sentences and proper grammar.\nNo hashtags or emojis. Be factual and concise.\n\nArticle: ${truncatedContent}`
        }]
      }]
    };

    const response = await axios.post(GEMINI_ENDPOINT, prompt, {
      headers: { 'Content-Type': 'application/json' }
    });

    let summary = response.data.candidates[0].content.parts[0].text;

    if (summary.length < MIN_SUMMARY_LENGTH) {
      return await generateStrictLengthSummary(content);
    }

    if (summary.length > MAX_SUMMARY_LENGTH) {
      summary = summary.substring(0, MAX_SUMMARY_LENGTH - 3) + '...';
    }

    return summary;
  } catch (error) {
    console.error("Gemini API error:", error.response?.data || error.message);
    return null;
  }
}

// Extract image or video from RSS item - IMPROVED
function extractMediaFromItem(item) {
  try {
    console.log(`[DEBUG] Extracting media from item: ${item.title}`);

    // Check enclosure (most common for RSS)
    if (item.enclosure && item.enclosure.url) {
      console.log(`[DEBUG] Found enclosure: ${item.enclosure.url}, type: ${item.enclosure.type}`);
      if (item.enclosure.type && item.enclosure.type.startsWith('image/')) {
        return { type: 'image', url: item.enclosure.url };
      }
      if (item.enclosure.type && item.enclosure.type.startsWith('video/')) {
        return { type: 'video', url: item.enclosure.url };
      }
    }

    // Check media:content
    if (item['media:content']) {
      let mediaContent = item['media:content'];
      // Handle array of media content
      if (Array.isArray(mediaContent)) {
        mediaContent = mediaContent[0];
      }

      if (mediaContent && mediaContent.$ && mediaContent.$.url) {
        console.log(`[DEBUG] Found media:content: ${mediaContent.$.url}, type: ${mediaContent.$.type}`);
        const mediaType = mediaContent.$.type || '';

        // If type is specified, use it
        if (mediaType.startsWith('image/')) {
          return { type: 'image', url: mediaContent.$.url };
        }
        if (mediaType.startsWith('video/')) {
          return { type: 'video', url: mediaContent.$.url };
        }

        // If no type specified, guess from URL extension
        const url = mediaContent.$.url;
        const ext = url.split('.').pop().toLowerCase().split('?')[0];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        const videoExts = ['mp4', 'mov', 'webm', 'avi'];

        if (imageExts.includes(ext)) {
          console.log(`[DEBUG] Detected image from extension: ${ext}`);
          return { type: 'image', url: url };
        }
        if (videoExts.includes(ext)) {
          console.log(`[DEBUG] Detected video from extension: ${ext}`);
          return { type: 'video', url: url };
        }
      }
    }


    // Parse HTML content for images/videos
    const contentToSearch = item['content:encoded'] || item.content || item.description || '';
    if (contentToSearch) {
      // Look for video tags
      const videoMatch = contentToSearch.match(/<video[^>]+src\s*=\s*['\"](.*?)['\"][^>]*>/i);
      if (videoMatch) {
        console.log(`[DEBUG] Found video in content: ${videoMatch[1]}`);
        return { type: 'video', url: videoMatch[1] };
      }

      // Look for source tags inside video (for feeds that use <source src=...>)
      const sourceMatch = contentToSearch.match(/<source[^>]+src\s*=\s*['\"](.*?)['\"][^>]*>/i);
      if (sourceMatch) {
        console.log(`[DEBUG] Found video source in content: ${sourceMatch[1]}`);
        return { type: 'video', url: sourceMatch[1] };
      }

      // Look for direct video links (e.g., .mp4, .webm) in the text
      const directVideoMatch = contentToSearch.match(/https?:\/\/[\w\-./%?=&]+\.(mp4|webm|mov|avi)/i);
      if (directVideoMatch) {
        console.log(`[DEBUG] Found direct video link in content: ${directVideoMatch[0]}`);
        return { type: 'video', url: directVideoMatch[0] };
      }

      // Look for img tags
      const imgMatch = contentToSearch.match(/<img[^>]+src\s*=\s*['\"](.*?)['\"][^>]*>/i);
      if (imgMatch) {
        console.log(`[DEBUG] Found image in content: ${imgMatch[1]}`);
        return { type: 'image', url: imgMatch[1] };
      }
    }

    // Check if there's a thumbnail or image URL in other fields
    if (item.image && item.image.url) {
      console.log(`[DEBUG] Found image URL: ${item.image.url}`);
      return { type: 'image', url: item.image.url };
    }

    console.log(`[DEBUG] No media found for: ${item.title}`);
    return null;
  } catch (err) {
    console.error('Error extracting media from item:', err.message);
    return null;
  }
}

// Validate and clean media URL
function validateMediaUrl(url) {
  try {
    if (!url) return null;

    // Remove tracking parameters and clean URL
    const cleanUrl = url.split('?')[0];

    // Check if it's a valid image/video extension
    const ext = cleanUrl.split('.').pop().toLowerCase();
    const validImageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const validVideoExts = ['mp4', 'mov', 'webm', 'avi'];

    if (validImageExts.includes(ext)) {
      return { type: 'image', url: cleanUrl };
    }
    if (validVideoExts.includes(ext)) {
      return { type: 'video', url: cleanUrl };
    }

    // If no clear extension but URL looks like media, try to determine type from content
    if (url.includes('/images/') || url.includes('/img/') || url.includes('image') || url.includes('.jpg') || url.includes('.png') || url.includes('.jpeg')) {
      return { type: 'image', url: url };
    }

    if (url.includes('/videos/') || url.includes('/video/') || url.includes('.mp4') || url.includes('.webm')) {
      return { type: 'video', url: url };
    }

    return null;
  } catch (err) {
    console.error('Error validating media URL:', err.message);
    return null;
  }
}

// Post tweet with image or video support - IMPROVED
async function postTweet(text, media) {
  if (DRY_RUN) {
    console.log('[DRY_RUN] Would post tweet:');
    console.log('Text:', text);
    if (media) console.log('Media:', media);
    return true;
  }
  const mimeFromExt = (url) => {
    if (!url) return null;
    const ext = url.split('.').pop().toLowerCase().split('?')[0];
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'webm': 'video/webm'
    };
    return mimeTypes[ext] || null;
  };

  const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideoTypes = ['video/mp4', 'video/quicktime', 'video/webm'];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let mediaIds = [];

      if (media && media.url) {
        try {
          console.log(`[DEBUG] Attempting to download media: ${media.url}`);

          // Download media with proper headers
          const response = await axios.get(media.url, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
              'Accept': 'image/*, video/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            },
            timeout: 30000,
            maxContentLength: 5 * 1024 * 1024, // 5MB limit
            maxRedirects: 5
          });

          const buffer = Buffer.from(response.data);
          const contentType = response.headers['content-type'] || '';
          const detectedMime = mimeFromExt(media.url);

          console.log(`[DEBUG] Downloaded ${buffer.length} bytes, content-type: ${contentType}, detected mime: ${detectedMime}`);

          // Use detected mime type or fallback to content-type
          const mimeType = detectedMime || contentType;

          if (media.type === 'image') {
            if (allowedImageTypes.includes(mimeType) || allowedImageTypes.includes(contentType)) {
              console.log(`[DEBUG] Uploading image with mime type: ${mimeType}`);
              const mediaId = await rwClient.v1.uploadMedia(buffer, { mimeType: mimeType || 'image/jpeg' });
              mediaIds.push(mediaId);
              console.log(`[DEBUG] Successfully uploaded image, mediaId: ${mediaId}`);
            } else {
              console.warn(`[WARN] Unsupported image type: ${mimeType} / ${contentType}, trying as jpeg`);
              // Try uploading as JPEG if mime type detection fails
              try {
                const mediaId = await rwClient.v1.uploadMedia(buffer, { mimeType: 'image/jpeg' });
                mediaIds.push(mediaId);
                console.log(`[DEBUG] Successfully uploaded image as JPEG, mediaId: ${mediaId}`);
              } catch (fallbackError) {
                console.error(`[ERROR] Failed to upload as JPEG: ${fallbackError.message}`);
              }
            }
          } else if (media.type === 'video') {
            if (allowedVideoTypes.includes(mimeType) || allowedVideoTypes.includes(contentType)) {
              console.log(`[DEBUG] Uploading video with mime type: ${mimeType}`);
              const mediaId = await rwClient.v1.uploadMedia(buffer, { mimeType: mimeType || 'video/mp4' });
              mediaIds.push(mediaId);
              console.log(`[DEBUG] Successfully uploaded video, mediaId: ${mediaId}`);
            } else {
              console.warn(`[WARN] Unsupported video type: ${mimeType} / ${contentType}`);
            }
          }
        } catch (mediaError) {
          console.error(`[ERROR] Failed to process media: ${mediaError.message}`);
          // Continue without media
        }
      }

      // Post tweet
      const tweetData = {
        text
      };

      if (mediaIds.length > 0) {
        tweetData.media = { media_ids: mediaIds };
        // Small delay after media upload to ensure it's processed
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const { data } = await rwClient.v2.tweet(tweetData);

      if (mediaIds.length > 0) {
        console.log(`✅ Tweet with ${media.type} posted: https://twitter.com/user/status/${data.id}`);
      } else {
        console.log(`✅ Text-only tweet posted: https://twitter.com/user/status/${data.id}`);
      }

      return true;

    } catch (error) {
      console.error(`❌ Failed to post tweet (Attempt ${attempt}):`, error.message);

      if (error.response && error.response.data) {
        console.error('[DEBUG] Twitter API error:', JSON.stringify(error.response.data, null, 2));
      }

      // Handle rate limiting
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 60;
        console.log(`⏳ Rate limited. Waiting ${retryAfter} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else if (attempt < MAX_RETRIES) {
        console.log(`🔄 Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  console.error("❌ All tweet attempts failed.");
  return false;
}

// Track posted article links persistently
const POSTED_LINKS_FILE = 'posted_links.json';
let postedLinks = new Set();
let postedLinksArray = []; // preserve order for diversity calculations
// posted_history.json feature removed
// Track last feed source for NO_CONSECUTIVE_FEED feature (configurable)
// Set env LAST_FEED_FILE to override. Default changed from last_feed.json to last_feed_state.json.
const LAST_FEED_FILE = process.env.LAST_FEED_FILE || 'last_feed_state.json';
const LEGACY_LAST_FEED_FILE = 'last_feed.json';
let lastFeedSource = null; // retained for NO_CONSECUTIVE_FEED logic only

// Deprecated persistence functions kept as no-ops for compatibility
function loadLastFeed() { /* stateless mode: no file load */ }
function saveLastFeed() { /* stateless mode: no file save */ }

// Load posted links from file
function loadPostedLinks() {
  try {
    if (fs.existsSync(POSTED_LINKS_FILE)) {
      const data = fs.readFileSync(POSTED_LINKS_FILE, 'utf-8');
      const arr = JSON.parse(data);
  postedLinksArray = Array.isArray(arr) ? arr : [];
  postedLinks = new Set(postedLinksArray);

      // Clean old links (keep only last 1000 to avoid memory issues)
      if (postedLinks.size > 1000) {
  postedLinksArray = postedLinksArray.slice(-1000);
  postedLinks = new Set(postedLinksArray);
        savePostedLinks();
      }

      console.log(`[DEBUG] Loaded ${postedLinks.size} posted links from file.`);
    }
  } catch (err) {
    console.error('[DEBUG] Failed to load posted links:', err.message);
  }
}

// Save posted links to file
function savePostedLinks() {
  try {
    // Ensure array reflects current set, preserving order (append-only pattern)
    // Remove any items no longer in set (should not normally happen)
    postedLinksArray = postedLinksArray.filter(l => postedLinks.has(l));
    fs.writeFileSync(POSTED_LINKS_FILE, JSON.stringify(postedLinksArray, null, 2));
    console.log(`[DEBUG] Saved ${postedLinks.size} posted links to file.`);
  } catch (err) {
    console.error('[DEBUG] Failed to save posted links:', err.message);
  }
}

function normalizeDomain(host) {
  if (!host) return host;
  host = host.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // Collapse common multi-subdomains
  if (host.endsWith('.indiatimes.com')) return 'indiatimes.com';
  if (host.endsWith('.thehindu.com')) return 'thehindu.com';
  if (host.endsWith('.indianexpress.com')) return 'indianexpress.com';
  return host;
}

// (diminishing returns feature removed)

function getRecentDomainCounts(lookback = DIVERSITY_LOOKBACK) {
  const counts = {};
  if (!postedLinksArray || !postedLinksArray.length) return counts;
  const sliceArr = postedLinksArray.slice(-lookback);
  for (const link of sliceArr) {
    try {
      const u = new URL(link);
      const d = normalizeDomain(u.hostname);
      counts[d] = (counts[d] || 0) + 1;
    } catch (_) { /* ignore */ }
  }
  return counts;
}

function getAllDomainFrequencies() {
  const counts = {};
  for (const link of postedLinksArray) {
    try {
      const d = normalizeDomain(new URL(link).hostname);
      counts[d] = (counts[d] || 0) + 1;
    } catch(_) { /* ignore */ }
  }
  return counts;
}

function getDomainStatsForLookback(lookback = DOMAIN_SHARE_LOOKBACK) {
  const counts = {};
  const slice = postedLinksArray.slice(-lookback);
  for (const link of slice) {
    try {
      const d = normalizeDomain(new URL(link).hostname);
      counts[d] = (counts[d] || 0) + 1;
    } catch(_) { /* ignore */ }
  }
  return { counts, total: slice.length };
}

function buildRecentWindowDomainSet(windowSize = 10) {
  if (windowSize <= 0) return new Set();
  const slice = postedLinksArray.slice(-windowSize);
  const s = new Set();
  for (const link of slice) {
    try { s.add(normalizeDomain(new URL(link).hostname)); } catch(_) {}
  }
  return s;
}

function filterCandidatesByDominance(candidates) {
  if (!candidates.length) return candidates;
  const { counts, total } = getDomainStatsForLookback();
  const lastDomain = postedLinksArray.length ? normalizeDomain(new URL(postedLinksArray[postedLinksArray.length - 1]).hostname) : null;
  const recentSet = buildRecentWindowDomainSet(MIN_UNIQUE_DOMAINS_WINDOW > 0 ? MIN_UNIQUE_DOMAINS_WINDOW : 0);
  const needNewDomain = MIN_UNIQUE_DOMAINS_WINDOW > 0 && recentSet.size < MIN_UNIQUE_DOMAINS_WINDOW;
  let filtered = candidates.filter(c => {
    const d = c.domain;
    const feedSrc = c.item && c.item._feedSource;
    if (!d) return true;
    if (NO_CONSECUTIVE_DOMAIN && lastDomain && d === lastDomain) return false;
    if (NO_CONSECUTIVE_FEED && lastFeedSource && feedSrc && feedSrc === lastFeedSource) return false;
    if (needNewDomain && recentSet.has(d)) return false;
    if (MAX_DOMAIN_SHARE > 0 && total > 0) {
      const curShare = (counts[d] || 0) / total;
      if (curShare > MAX_DOMAIN_SHARE) return false;
    }
    return true;
  });
  if (!filtered.length) {
    // fallback: relax uniqueness, then share, then consecutive
    filtered = candidates.filter(c => {
      const d = c.domain;
      const feedSrc = c.item && c.item._feedSource;
      if (!d) return true;
      if (MAX_DOMAIN_SHARE > 0 && total > 0) {
        const curShare = (counts[d] || 0) / total;
        if (curShare > MAX_DOMAIN_SHARE) return false;
      }
      if (NO_CONSECUTIVE_DOMAIN && lastDomain && d === lastDomain) return false;
      if (NO_CONSECUTIVE_FEED && lastFeedSource && feedSrc && feedSrc === lastFeedSource) return false;
      return true;
    });
  }
  if (!filtered.length) filtered = candidates; // absolute fallback
  return filtered;
}

async function processOneTweet() {
  try {
  debugLog('Starting processOneTweet function');


    let allArticles = [];
    // Fetch and collect articles from all feeds
    debugLog(`Processing ${rssFeeds.length} RSS feeds`);
    for (const feedUrl of rssFeeds) {
      try {
  debugLog(`Fetching feed: ${feedUrl}`);

  const items = await fetchFeedWithRetry(feedUrl, 2);
  debugLog(`Found ${items.length} items in feed: ${feedUrl}`);
  // Annotate each item with its originating feed for feed-level diversity rules
  allArticles.push(...items.slice(0, 5).map(it => ({ ...it, _feedSource: feedUrl })));
        
        // Minimal delay for GitHub Actions (reduce from 1500ms to 300ms)
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        console.error(`❌ Failed to fetch or parse feed: ${feedUrl} - ${err.message}`);
      }
    }

    // Filter articles to only those published in the last 2 hours
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    allArticles = allArticles.filter(item => {
      let pubDate = item.isoDate || item.pubDate || item.published || item.date;
      if (!pubDate) return false;
      let articleDate = new Date(pubDate);
      return articleDate > twoHoursAgo && articleDate <= now;
    });

    if (allArticles.length === 0) {
      debugLog("No articles found in the last 2 hours, returning false");
      console.log("⚠️ No articles found in the last 2 hours.");
      return false;
    }

  debugLog(`Total articles collected in last 2 hours: ${allArticles.length}`);

    // Score all articles for general news, sort by score descending
    let scoredArticles = [];
  const recentDomainCounts = DIVERSITY_ENABLED ? getRecentDomainCounts() : {};
    for (const item of allArticles) {
  debugLog(`Processing article: ${item.title}`);

      let content = item['content:encoded'] || item.content;
      if (!content || content.length < 300) {
        content = await extractArticleContent(item.link);
        // Minimal delay for GitHub Actions (reduce from 1000ms to 200ms)
        if (content) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      if (!content || content.length < 300) continue;

      // Extract and validate media
      const rawMedia = extractMediaFromItem(item);
      const media = rawMedia ? validateMediaUrl(rawMedia.url) : null;

      debugLog(`Media extraction result for "${item.title}":`, { rawMedia, media });

      if (media) {
        console.log(`[DEBUG] Valid media found for "${item.title}": ${media.type} - ${media.url}`);
      } else if (rawMedia) {
        console.log(`[DEBUG] Raw media found but validation failed for "${item.title}": ${rawMedia.url}`);
      }

      // Score using local keyword method
      // UPSC-relevant keywords (comprehensive)
      const keywords = [
        // Polity & Constitution
        "constitution", "constitutional", "amendment", "fundamental rights", "directive principles", "dpsp", "preamble", "parliament", "president", "prime minister", "cabinet", "governor", "chief minister", "supreme court", "high court", "judiciary", "election commission", "cag", "attorney general", "niti aayog", "finance commission", "panchayat", "municipality", "federalism", "union", "state government", "central government", "legislature", "executive", "judicial review", "public interest litigation", "panchayati raj", "lok sabha", "rajya sabha", "bicameral", "unicameral", "ordinance", "bill", "act", "law", "governance", "civil services", "upsc", "ias", "ips", "ifs",
        // Economy
        "gdp", "inflation", "fiscal deficit", "current account deficit", "monetary policy", "repo rate", "reverse repo", "rbi", "banking", "npas", "gst", "tax", "budget", "economic survey", "niti aayog", "planning commission", "msme", "startup", "disinvestment", "privatization", "public sector", "subsidy", "poverty", "unemployment", "employment", "labour", "agriculture", "farmer", "crop", "minimum support price", "msme", "industry", "manufacturing", "service sector", "exports", "imports", "trade deficit", "balance of payments", "fdi", "fii", "stock market", "sebi", "bank", "insurance", "microfinance", "financial inclusion", "direct benefit transfer", "dbt", "aadhar", "jan dhan", "demonetisation", "black money", "income tax", "corporate tax", "customs duty", "excise duty", "public finance", "wto", "imf", "world bank", "brics", "g20",
        // Environment & Ecology
        "environment", "ecology", "biodiversity", "conservation", "wildlife", "forest", "climate change", "global warming", "carbon emission", "cop", "unfccc", "ipcc", "paris agreement", "ozone", "pollution", "air quality", "water conservation", "afforestation", "deforestation", "project tiger", "project elephant", "biosphere reserve", "national park", "wildlife sanctuary", "ramsar", "wetland", "mangrove", "coral reef", "ganga", "yamuna", "river", "clean energy", "renewable energy", "solar", "wind energy", "hydro power", "environmental impact assessment", "eia", "green tribunal", "ngt", "environment ministry", "moefcc",
        // Science & Tech
        "isro", "drdo", "space", "satellite", "mission", "mars", "moon", "chandrayaan", "gaganyaan", "nuclear", "missile", "defence", "technology", "innovation", "digital india", "artificial intelligence", "ai", "machine learning", "robotics", "biotechnology", "genome", "dna", "vaccine", "covid", "pandemic", "health", "disease", "medicine", "pharma", "research", "patent", "intellectual property", "cyber", "internet", "data protection", "privacy", "it act", "blockchain", "cryptocurrency", "fintech", "startups",
        // International Relations
        "united nations", "un", "security council", "imf", "world bank", "wto", "brics", "saarc", "asean", "g20", "g7", "bilateral", "multilateral", "treaty", "agreement", "summit", "foreign policy", "diplomacy", "border", "china", "pakistan", "usa", "russia", "nepal", "bangladesh", "sri lanka", "maldives", "afghanistan", "iran", "trade deal", "fta", "strategic partnership", "defence cooperation", "aid", "development assistance",
        // Social Issues
        "poverty", "inequality", "gender", "women", "child", "education", "literacy", "school", "university", "reservation", "caste", "tribe", "sc", "st", "obc", "minority", "disability", "health", "malnutrition", "sanitation", "swachh bharat", "ayushman bharat", "mid day meal", "beti bachao", "ujjwala", "social justice", "social welfare", "ngo", "civil society", "human rights", "child rights", "women rights", "transgender", "old age", "pension", "employment guarantee", "mgnrega", "skill india", "digital literacy", "financial inclusion", "urbanization", "slum", "housing", "pradhan mantri awas yojana", "pmay", "smart cities", "urban development", "rural development", "gram panchayat", "self help group", "shg",
        // Government Schemes & Initiatives
        "scheme", "yojana", "mission", "initiative", "pradhan mantri", "pm", "jan dhan", "aadhar", "ujjwala", "mudra", "startup india", "standup india", "swachh bharat", "ayushman bharat", "digital india", "make in india", "skill india", "beti bachao", "beti padhao", "pm kisan", "pmjay", "pmay", "mgnrega", "mid day meal", "rte", "right to education", "right to information", "rti", "right to food", "right to health", "insurance scheme", "crop insurance", "fasal bima", "pension scheme", "old age pension", "social security", "direct benefit transfer", "dbt", "public distribution system", "pds", "ration card", "food security", "national health mission", "nhm", "icds", "anganwadi", "tribal affairs", "minority affairs", "backward class", "sc", "st", "obc", "women empowerment", "child development", "youth affairs", "sports", "khelo india",
        // History & Culture
        "history", "ancient", "medieval", "modern", "freedom struggle", "independence", "gandhi", "nehru", "ambedkar", "subhash chandra bose", "bhagat singh", "reform", "renaissance", "art", "architecture", "culture", "heritage", "unesco", "festival", "dance", "music", "painting", "literature", "language", "archaeology", "monument", "temple", "mosque", "church", "buddhism", "jainism", "hinduism", "islam", "sikhism", "religion", "philosophy", "social reform", "women reformer", "tribal movement", "peasant movement", "dalit movement",
        // Current Affairs & Misc
        "current affairs", "important", "significant", "notable", "landmark", "record", "highest", "lowest", "first time", "last", "new", "update", "decision", "verdict", "judgment", "order", "ban", "strike", "protest", "violence", "arrest", "attack", "death", "disaster", "flood", "drought", "earthquake", "cyclone", "epidemic", "pandemic", "outbreak", "security", "terrorism", "internal security", "naxal", "insurgency", "border security", "defence", "armed forces", "paramilitary", "police", "crime", "corruption", "scam", "investigation", "probe", "enforcement directorate", "cbi", "ed", "ncb", "narcotics", "money laundering", "hawala", "cyber crime", "cyber security", "data breach", "privacy", "right to privacy"
      ];

      let keywordScore = 0;
      const lowerContent = content.toLowerCase();
      let score = 0;
      // Define keyword groups for custom weighting
      const economyKeywords = [
        "gdp", "inflation", "fiscal deficit", "current account deficit", "monetary policy", "repo rate", "reverse repo", "rbi", "banking", "npas", "gst", "tax", "budget", "economic survey", "niti aayog", "planning commission", "msme", "startup", "disinvestment", "privatization", "public sector", "subsidy", "unemployment", "employment", "labour", "industry", "manufacturing", "service sector", "exports", "imports", "trade deficit", "balance of payments", "fdi", "fii", "stock market", "sebi", "bank", "insurance", "microfinance", "financial inclusion", "direct benefit transfer", "dbt", "aadhar", "jan dhan", "demonetisation", "black money", "income tax", "corporate tax", "customs duty", "excise duty", "public finance", "wto", "imf", "world bank", "brics", "g20"
      ];
      const highPriorityKeywords = [
        // National/constitutional
        "supreme court", "high court", "parliament", "president", "prime minister", "cabinet", "governor", "chief minister", "election commission", "judiciary", "law", "governance", "civil services", "upsc", "ias", "ips", "ifs", "ordinance", "bill", "act", "constitution", "amendment", "public interest litigation",
        // Science/tech/health
        "isro", "drdo", "space", "satellite", "mission", "mars", "moon", "chandrayaan", "gaganyaan", "nuclear", "missile", "defence", "technology", "innovation", "digital india", "artificial intelligence", "ai", "machine learning", "robotics", "biotechnology", "genome", "dna", "vaccine", "covid", "pandemic", "health", "disease", "medicine", "pharma", "research", "patent", "cyber", "internet", "data protection", "privacy", "blockchain", "fintech",
        // Environment
        "environment", "ecology", "biodiversity", "conservation", "wildlife", "forest", "climate change", "global warming", "carbon emission", "cop", "unfccc", "ipcc", "paris agreement", "ozone", "pollution", "air quality", "water conservation", "afforestation", "deforestation", "project tiger", "project elephant", "biosphere reserve", "national park", "wildlife sanctuary", "ramsar", "wetland", "mangrove", "coral reef", "clean energy", "renewable energy", "solar", "wind energy", "hydro power", "environmental impact assessment", "eia", "green tribunal", "ngt", "environment ministry", "moefcc",
        // Major current affairs
        "disaster", "flood", "drought", "earthquake", "cyclone", "epidemic", "pandemic", "outbreak", "security", "terrorism", "internal security", "naxal", "insurgency", "border security", "defence", "armed forces", "paramilitary", "police", "crime", "corruption", "scam", "investigation", "probe", "enforcement directorate", "cbi", "ed", "ncb", "narcotics", "money laundering", "hawala", "cyber crime", "cyber security", "data breach", "privacy", "right to privacy",
        // Landmark events
        "important", "significant", "notable", "landmark", "record", "highest", "lowest", "first time", "verdict", "judgment", "order", "ban", "strike", "protest", "violence", "arrest", "attack", "death"
      ];
      // Score high-priority keywords (weight 3)
      for (const kw of highPriorityKeywords) {
        if (lowerContent.includes(kw)) score += 3;
      }
      // Score economy/finance keywords (weight 0.5)
      for (const kw of economyKeywords) {
        if (lowerContent.includes(kw)) score += 0.5;
      }
      // Score all other keywords (weight 1)
      for (const kw of keywords) {
        if (
          !highPriorityKeywords.includes(kw) &&
          !economyKeywords.includes(kw) &&
          lowerContent.includes(kw)
        ) {
          score += 1;
        }
      }

      // Boost score based on media type priority: videos > images > text-only
      if (media) {
        if (media.type === 'video') {
          score += 5; // Highest priority for videos
        } else if (media.type === 'image') {
          score += 3; // Medium priority for images
        }
      }
      // Text-only articles get no media boost
  let diversityPenalty = 0;
      if (DIVERSITY_ENABLED) {
        try {
          const host = item.link ? normalizeDomain(new URL(item.link).hostname) : null;
          if (host) {
            const pastCount = recentDomainCounts[host] || 0;
            if (pastCount > 0) {
              diversityPenalty = Math.log(1 + pastCount) * DIVERSITY_PENALTY_WEIGHT;
              score -= diversityPenalty;
            }
          }
        } catch (_) { /* ignore */ }
      }
  // attach normalized domain for later selection filtering
  let domain = null;
  try { domain = item.link ? normalizeDomain(new URL(item.link).hostname) : null; } catch(_) {}
  scoredArticles.push({ item, score, media, diversityPenalty, domain });
    }

    // Sort by score descending, then by media type priority (video > image > text-only)
    scoredArticles.sort((a, b) => {
      // First sort by score
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      // If scores are equal, prioritize by media type
      const getMediaPriority = (media) => {
        if (!media) return 0; // text-only
        if (media.type === 'video') return 3;
        if (media.type === 'image') return 2;
        return 1;
      };

      return getMediaPriority(b.media) - getMediaPriority(a.media);
    });
    console.log(`[DEBUG] Scored ${scoredArticles.length} articles`);

    // Show top 3 articles with their scores for debugging
    console.log(`[DEBUG] Top articles by priority:`);
    for (let i = 0; i < Math.min(5, scoredArticles.length); i++) {
  const { item, score, media, diversityPenalty } = scoredArticles[i];
      const mediaInfo = media ? `${media.type}` : 'text-only';
      const parts = [`${i + 1}. Score: ${score.toFixed(2)}`];
      if (DIVERSITY_ENABLED) parts.push(`divPenalty:${diversityPenalty.toFixed(2)}`);
      console.log(`[DEBUG] ${parts.join(' ')} | Media: ${mediaInfo} | "${item.title.substring(0, 60)}..."`);
    }

    // Try each article in order of priority, only tweet if Gemini summary is available
    if (BALANCED_SELECTION) {
      console.log('[DEBUG] Using balanced domain selection strategy');
      // Build best article per domain
      const bestPerDomain = {};
      for (const entry of scoredArticles) {
        const link = entry.item.link || entry.item.guid;
        if (!link) continue;
        const domain = entry.domain;
        if (!domain) continue;
        if (!bestPerDomain[domain] || entry.score > bestPerDomain[domain].score) {
          bestPerDomain[domain] = entry;
        }
      }
      const domainFreq = getAllDomainFrequencies();
      const reps = Object.keys(bestPerDomain).map(d => ({ domain: d, ...bestPerDomain[d], freq: domainFreq[d] || 0 }));
      if (!reps.length) {
        console.log('[DEBUG] No representatives found, aborting');
        return false;
      }
      // Find minimum frequency among domains
      const minFreq = Math.min(...reps.map(r => r.freq));
      // Filter reps with min frequency
      let candidates = reps.filter(r => r.freq === minFreq);
      candidates = filterCandidatesByDominance(candidates);
      // Sort candidates by score desc
      candidates.sort((a,b)=> b.score - a.score);
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const { item, score, media, domain } = candidates[attempt];
        const link = item.link || item.guid;
        if (!link || postedLinks.has(link)) continue;
        let content = item['content:encoded'] || item.content;
        if (!content || content.length < 300) {
          content = await extractArticleContent(item.link);
        }
        if (!content || content.length < 300) continue;
        let summary = null;
        try {
          console.log(`[DEBUG] (Balanced) Generating Gemini summary for domain ${domain} (score: ${score}, freq: ${domainFreq[domain]||0})`);
          summary = await generateStrictLengthSummary(content);
        } catch (err) {
          console.error('[ERROR] Summary failed, trying next domain candidate:', err.message);
          continue;
        }
        if (!summary) continue;
        console.log(`\n📌 Posting (balanced) domain=${domain} score=${score.toFixed(2)} freq=${domainFreq[domain]||0}: ${item.title}`);
        console.log(`📝 Summary: ${summary}`);
        console.log(`📏 Length: ${summary.length}/280`);
        if (media) console.log(`🖼️ Media: ${media.type} - ${media.url}`);
        const success = await postTweet(summary, media);
        if (success) {
          postedLinks.add(link);
          postedLinksArray.push(link);
          savePostedLinks();
          if (NO_CONSECUTIVE_FEED && item._feedSource) saveLastFeed(item._feedSource);
          return true;
        }
      }
    } else {
      // Apply dominance filters to top slice first
      let linearCandidates = scoredArticles.slice(0, 12); // wider pool for filtering
      linearCandidates = filterCandidatesByDominance(linearCandidates);
      for (let i = 0; i < Math.min(linearCandidates.length, 8); i++) {
        const { item, score, media } = linearCandidates[i];
        const link = item.link || item.guid;
        if (!link || postedLinks.has(link)) {
          console.log(`[DEBUG] Skipping already posted article: ${item.title}`);
          continue;
        }
        let content = item['content:encoded'] || item.content;
        if (!content || content.length < 300) {
          content = await extractArticleContent(item.link);
        }
        if (!content || content.length < 300) continue;
        let summary = null;
        try {
          console.log(`[DEBUG] Generating Gemini summary for article ${i + 1} (score: ${score}, media: ${media ? media.type : 'none'})`);
          summary = await generateStrictLengthSummary(content);
        } catch (err) {
          console.error(`[ERROR] Failed to generate summary: ${err.message}`);
          continue; // Skip this article if Gemini summary fails
        }
        if (!summary) continue;
        console.log(`\n📌 Posting article (score: ${score}): ${item.title}`);
        console.log(`📝 Summary: ${summary}`);
        console.log(`📏 Length: ${summary.length}/280`);
        if (media) console.log(`🖼️ Media: ${media.type} - ${media.url}`);
        const success = await postTweet(summary, media);
        if (success) {
          postedLinks.add(link);
          postedLinksArray.push(link);
          savePostedLinks();
          if (NO_CONSECUTIVE_FEED && item._feedSource) saveLastFeed(item._feedSource);
          return true;
        }
      }
    }

    console.log("⚠️ No suitable article found for tweeting.");
    return false;
  } catch (err) {
    console.error("❌ Error in processOneTweet:", err.message);
    return false;
  }
}

// Stateless round-robin feed posting: select feed based on wall-clock slot
async function processOneTweetRoundRobin() {
  try {
    if (!rssFeeds.length) {
      console.log('⚠️ No feeds configured.');
      return false;
    }
    // Determine base feed index by time slot (stateless)
    const slot = Math.floor(Date.now() / (ROTATION_INTERVAL_MINUTES * 60 * 1000));
    const startIndex = slot % rssFeeds.length;
    console.log(`[RR] Computed time-slot ${slot}, starting at feed index ${startIndex}`);
    // We'll attempt starting feed then fall through others if it yields nothing
    for (let offset = 0; offset < rssFeeds.length; offset++) {
      const feedIndex = (startIndex + offset) % rssFeeds.length;
      const feedUrl = rssFeeds[feedIndex];
      debugLog(`[RR] Attempting feed index ${feedIndex}: ${feedUrl}`);
      let items = [];
      try {
        items = await fetchFeedWithRetry(feedUrl, 2);
      } catch (e) {
        console.warn(`[RR] Failed to fetch feed ${feedUrl}: ${e.message}`);
        continue;
      }
      if (!items.length) continue;
      // Limit items processed
      items = items.slice(0, 8).map(it => ({ ...it, _feedSource: feedUrl }));
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const freshItems = items.filter(it => {
        let pubDate = it.isoDate || it.pubDate || it.published || it.date;
        if (!pubDate) return false;
        const d = new Date(pubDate);
        return d > twoHoursAgo && d <= now;
      });
      if (!freshItems.length) {
        debugLog(`[RR] No fresh items (<=2h) in feed ${feedUrl}`);
        continue;
      }
      // Score within this single feed
      const recentDomainCounts = DIVERSITY_ENABLED ? getRecentDomainCounts() : {};
      const scored = [];
      for (const item of freshItems) {
        let content = item['content:encoded'] || item.content;
        if (!content || content.length < 300) {
          content = await extractArticleContent(item.link);
        }
        if (!content || content.length < 300) continue;
        const rawMedia = extractMediaFromItem(item);
        const media = rawMedia ? validateMediaUrl(rawMedia.url) : null;
        const lowerContent = content.toLowerCase();
        let score = 0;
        // Minimal scoring: prefer presence of a few key signals + media
        const quickKeywords = ['government','policy','economy','market','technology','environment','court','india','global'];
        for (const kw of quickKeywords) if (lowerContent.includes(kw)) score += 1;
        if (media) score += media.type === 'video' ? 5 : 3;
        // Diversity penalty
        if (DIVERSITY_ENABLED) {
          try {
            const host = item.link ? normalizeDomain(new URL(item.link).hostname) : null;
            if (host) {
              const pastCount = recentDomainCounts[host] || 0;
              if (pastCount > 0) score -= Math.log(1 + pastCount) * DIVERSITY_PENALTY_WEIGHT;
            }
          } catch(_) {}
        }
        let domain = null;
        try { domain = item.link ? normalizeDomain(new URL(item.link).hostname) : null; } catch(_) {}
        scored.push({ item, score, media, domain });
      }
      if (!scored.length) {
        debugLog(`[RR] No scored items for feed ${feedUrl}`);
        continue;
      }
      scored.sort((a,b)=> b.score - a.score);
      // Try candidates in descending score
      for (const entry of scored.slice(0,5)) {
        const { item, score, media } = entry;
        const link = item.link || item.guid;
        if (!link || postedLinks.has(link)) continue;
        let content = item['content:encoded'] || item.content;
        if (!content || content.length < 300) {
          content = await extractArticleContent(item.link);
        }
        if (!content || content.length < 300) continue;
        let summary = null;
        try {
          summary = await generateStrictLengthSummary(content);
        } catch (e) {
          console.warn(`[RR] Summary failed for an item: ${e.message}`);
          continue;
        }
        if (!summary) continue;
        console.log(`\n🔄 [Round-Robin] Posting from feed #${feedIndex + 1}/${rssFeeds.length}: ${feedUrl}`);
        console.log(`📰 Title: ${item.title}`);
        console.log(`⭐ Score: ${score.toFixed(2)}`);
        console.log(`📝 Summary: ${summary}`);
        console.log(`📏 Length: ${summary.length}/280`);
        if (media) console.log(`🖼️ Media: ${media.type} - ${media.url}`);
        const success = await postTweet(summary, media);
        if (success) {
          postedLinks.add(link);
          postedLinksArray.push(link);
          savePostedLinks();
          // Save lastFeedSource only for NO_CONSECUTIVE_FEED logic (no persistence)
          lastFeedSource = feedUrl;
          return true;
        }
      }
      // If we've reached here, this feed had items but none posted; try next feed
    }
    console.log('⚠️ Round-robin: no suitable article found across all feeds this cycle.');
    return false;
  } catch (err) {
    console.error('❌ Error in processOneTweetRoundRobin:', err.message);
    return false;
  }
}

// Strict rotation: attempt ONLY the computed feed; expand freshness window if needed.
async function processOneTweetStrictRotation() {
  try {
    if (!rssFeeds.length) {
      console.log('⚠️ No feeds configured.');
      return false;
    }
    const feedIndex = postedLinksArray.length % rssFeeds.length; // advance only after success
    const feedUrl = rssFeeds[feedIndex];
    console.log(`[STRICT] Target feed #${feedIndex + 1}/${rssFeeds.length}: ${feedUrl}`);
    let items = [];
    try {
      items = await fetchFeedWithRetry(feedUrl, 2);
    } catch (e) {
      console.warn(`[STRICT] Failed to fetch feed: ${e.message}`);
      return false; // do not advance
    }
    if (!items.length) {
      console.log('[STRICT] No items in feed.');
      return false;
    }
    // Work through expansion windows
    for (const windowSpec of STRICT_EXPANSION_WINDOWS) {
      const win = windowSpec.trim();
      if (!win) continue;
      const match = win.match(/^(\d+)([hm])$/i);
      let hours = 2; // default
      if (match) {
        const val = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        hours = unit === 'm' ? val / 60 : val;
      }
      const now = new Date();
      const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
      let windowItems = items.slice(0, 15).map(it => ({ ...it, _feedSource: feedUrl })).filter(it => {
        const pubDate = it.isoDate || it.pubDate || it.published || it.date;
        if (!pubDate) return false;
        const d = new Date(pubDate);
        return d > cutoff && d <= now;
      });
      if (!windowItems.length) {
        console.log(`[STRICT] No items within window ${win}. Expanding...`);
        continue;
      }
      // Score within feed (reuse minimal scoring)
      const recentDomainCounts = DIVERSITY_ENABLED ? getRecentDomainCounts() : {};
      const scored = [];
      for (const item of windowItems) {
        let content = item['content:encoded'] || item.content;
        if (!content || content.length < 300) {
          content = await extractArticleContent(item.link);
        }
        if (!content || content.length < 300) continue;
        const rawMedia = extractMediaFromItem(item);
        const media = rawMedia ? validateMediaUrl(rawMedia.url) : null;
        let score = 0;
        const lower = (content || '').toLowerCase();
        const quickKeywords = ['government','policy','economy','market','technology','environment','court','india','global'];
        for (const kw of quickKeywords) if (lower.includes(kw)) score += 1;
        if (media) score += media.type === 'video' ? 5 : 3;
        if (DIVERSITY_ENABLED) {
          try {
            const host = item.link ? normalizeDomain(new URL(item.link).hostname) : null;
            if (host) {
              const past = recentDomainCounts[host] || 0;
              if (past > 0) score -= Math.log(1 + past) * DIVERSITY_PENALTY_WEIGHT;
            }
          } catch(_) {}
        }
        scored.push({ item, score, media });
      }
      if (!scored.length) {
        console.log(`[STRICT] No viable articles after content extraction in window ${win}.`);
        continue;
      }
      scored.sort((a,b)=> b.score - a.score);
      for (const { item, score, media } of scored.slice(0,5)) {
        const link = item.link || item.guid;
        if (!link || postedLinks.has(link)) continue;
        let content = item['content:encoded'] || item.content;
        if (!content || content.length < 300) content = await extractArticleContent(item.link);
        if (!content || content.length < 300) continue;
        let summary = null;
        try {
          summary = await generateStrictLengthSummary(content);
        } catch (e) {
          console.warn(`[STRICT] Summary failed: ${e.message}`);
          continue;
        }
        if (!summary) continue;
        console.log(`\n🎯 [Strict Rotation] Posting from feed #${feedIndex + 1}: ${feedUrl}`);
        console.log(`📰 Title: ${item.title}`);
        console.log(`⭐ Score: ${score.toFixed(2)}`);
        console.log(`📝 Summary: ${summary}`);
        console.log(`📏 Length: ${summary.length}/280`);
        if (media) console.log(`🖼️ Media: ${media.type} - ${media.url}`);
        const success = await postTweet(summary, media);
        if (success) {
          postedLinks.add(link);
          postedLinksArray.push(link);
          savePostedLinks();
          lastFeedSource = feedUrl;
          return true; // feedIndex advances next run via postedLinksArray length
        }
      }
      console.log(`[STRICT] Could not post from window ${win}; trying next larger window.`);
    }
    console.log('[STRICT] All expansion windows exhausted; will retry same feed next run.');
    return false;
  } catch (err) {
    console.error('❌ Error in processOneTweetStrictRotation:', err.message);
    return false;
  }
}

async function processUntilTweetPosted(maxAttempts = 3) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`\n🌀 Overall Attempt ${attempt} to post tweet...`);
  const success = STRICT_ROTATION ? await processOneTweetStrictRotation() : (ROUND_ROBIN_FEEDS ? await processOneTweetRoundRobin() : await processOneTweet());
    if (success) return;
    if (attempt < 3) {
      console.log("🔁 Retrying in 5 seconds...");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log("❌ All attempts to post tweet failed.");
}

(async () => {
  console.log("🚀 Starting scheduled summarizer...");
  loadPostedLinks();
  if (NO_CONSECUTIVE_FEED) loadLastFeed();
  await processUntilTweetPosted(3);
  console.log("🏁 Finished");
})();