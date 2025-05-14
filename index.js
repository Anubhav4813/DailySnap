require('dotenv').config();
const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');

// Configure APIs

// https://newsapi.org/v2/top-headlines?sources=google-news-in&apiKey=${process.env.NEWS_API_KEY}

const newsApiUrl = `https://newsapi.org/v2/top-headlines?sources=google-news-in&apiKey=${process.env.NEWS_API_KEY}`;
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

function formatTweet(article) {
  const maxTitleLength = 256 - 24; // 280 chars - 23 (URL) - 1 (space)
  let title = article.title.trim();

  if (title.length > maxTitleLength) {
    title = title.substring(0, maxTitleLength - 3) + '...';
  }

  return `${title} ${article.url}`;
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
    const tweet = formatTweet(article);
    await postToX(tweet);
  } catch (error) {
    console.error('App error:', error.message);
    process.exit(1);
  }
})();