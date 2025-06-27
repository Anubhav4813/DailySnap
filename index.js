require('dotenv').config();
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');

// Configure APIs

const newsApiUrl = `https://newsapi.org/v2/top-headlines?country=us&category=business&apiKey=${process.env.NEWS_API_KEY}`;
const xClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

async function fetchLatestNews() {
  try {
    const response = await axios.get(newsApiUrl);
    
    if (response.data.status !== 'ok') {
      throw new Error('News API response not OK');
    }

    const validArticles = response.data.articles.filter(article => 
      article.title && article.url
    );

    if (!validArticles.length) {
      throw new Error('No valid articles found');
    }

    return validArticles[0];
  } catch (error) {
    console.error('News fetch error:', error.message);
    throw error;
  }
}


// Summarize the article (up to ~280 chars from description/content)
function summarizeArticle(article) {
  let text = '';
  if (article.description) {
    text = article.description;
  } else if (article.content) {
    text = article.content;
  } else {
    text = '';
  }
  // Trim to 280 chars, avoid cutting mid-word
  if (text.length > 280) {
    let trimmed = text.slice(0, 280);
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 0) trimmed = trimmed.slice(0, lastSpace);
    return trimmed.trim() + '...';
  }
  return text.trim();
}

function formatTweet(article, summary) {
  // Reserve space for URL and summary
  const maxTweetLength = 280;
  const urlLength = 23; // Twitter/X shortens URLs to 23 chars
  const spaceForSummary = summary ? summary.length + 2 : 0; // 2 for dash and space
  const maxTitleLength = maxTweetLength - urlLength - 1 - spaceForSummary;
  let title = article.title.trim();
  if (title.length > maxTitleLength) {
    title = title.substring(0, maxTitleLength - 3) + '...';
  }
  if (summary) {
    return `${title} - ${summary} ${article.url}`;
  } else {
    return `${title} ${article.url}`;
  }
}

async function postToX(tweetText) {
  try {
    const { data } = await xClient.v2.tweet(tweetText);
    console.log('Successfully posted to X:', data);
    return data;
  } catch (error) {
    console.error('X post error:', error);
    throw error;
  }
}


(async () => {
  try {
    const article = await fetchLatestNews();
    const summary = summarizeArticle(article);
    const tweet = formatTweet(article, summary);
    await postToX(tweet);
  } catch (error) {
    console.error('App error:', error.message);
    process.exit(1);
  }
})();