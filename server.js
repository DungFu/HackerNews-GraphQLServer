const { GraphQLServer } = require('graphql-yoga')
const fetch = require('node-fetch')

const delay = (ms) => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}
const retryFetch = (url, fetchOptions={}, retries=3, retryDelay=500) => {
  return new Promise((resolve, reject) => {
    const wrapper = n => {
      fetch(url, fetchOptions)
        .then(res => { resolve(res) })
        .catch(async err => {
          if(n > 0) {
            // console.log(`retrying ${n}`)
            await delay(retryDelay)
            wrapper(--n)
          } else {
            reject(err)
          }
        })
    }

    wrapper(retries)
  })
}

const {promisify} = require('util')
const redis = require("redis")
const client = redis.createClient()
const getAsync = promisify(client.get).bind(client);

const baseURL = 'https://hacker-news.firebaseio.com/v0'
const MAX_FETCH_NUM = 20
const CACHING_INTERVAL = 300 * 1000

const resolvers = {
  Query: {
    stories: (parent, args) => fetchStories(args),
    item: (parent, args) => fetchItem(args.id),
    user: (parent, args) => fetchUser(args.id),
  },
  ItemEdge: {
    node: (parent, args) => parent,
    cursor: (parent, args) => parent.id,
  },
  ItemConnection: {
    pageInfo: (parent, args) => parent.pageInfo,
    count: (parent, args) => parent.count,
    edges: (parent, args) => fetchItems(parent.edges, args)
  },
  Item: {
    kids: (parent, args) => filterFirstAfter(parent.kids, args),
    parts: (parent, args) => filterFirstAfter(parent.parts, args),
    by: parent => fetchUser(parent.by),
    by_id: parent => parent.by,
    parent: parent => fetchItem(parent.parent),
    poll: parent => fetchItem(parent.poll),
  },
  User: {
    submitted: (parent, args) => filterFirstAfter(parent.submitted, args)
  }
}

function filterFirstAfter(arr, args) {
  if (arr) {
    let startIndex = 0
    if (args.after) {
      const index = arr.indexOf(Number(args.after))
      if (index >= 0) {
        startIndex = Math.min(index + 1, arr.length - 1);
      }
    }
    if (!(args.first > 0 && args.first <= MAX_FETCH_NUM)) {
      args.first = MAX_FETCH_NUM
    }
    const items = arr.slice(startIndex, startIndex + args.first)
    return {
      pageInfo: {
        hasNextPage: startIndex + args.first < arr.length,
        hasPreviousPage: startIndex > 0,
        startCursor: items.length > 0 ? items[0] : null,
        endCursor: items.length > 0 ? items[items.length - 1] : null,
      },
      count: arr.length,
      edges: items,
    }
  }
  return {
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
    count: 0,
    edges: [],
  }
}

function fetchStories(args, override_cache=false) {
  const storiesFetchPromise =
    retryFetch(`${baseURL}/${args.category}.json`)
      .then(res => {
        const resJsonPromise = res.json()
        resJsonPromise.then(resJson => {
          client.set(args.category, JSON.stringify(resJson))
          client.set(args.category + ":time", Date.now())
        })
        return resJsonPromise
      })
  if (override_cache) {
    return storiesFetchPromise.then(storiesJson => {
      return filterFirstAfter(storiesJson, args)
    })
  }
  return Promise.all([
    getAsync(args.category),
    getAsync(args.category + ":time")
  ]).then((data) => {
    if (data[0] === null || Date.now() - Number(data[1]) > CACHING_INTERVAL) {
      return storiesFetchPromise
    }
    return JSON.parse(data[0])
  }).catch(err => {
    console.error(err)
    return storiesFetchPromise
  }).then(storiesJson => {
    return filterFirstAfter(storiesJson, args)
  })
}

function fetchItem(itemId, override_cache=false) {
  if (itemId) {
    const itemFetchPromise =
      retryFetch(`${baseURL}/item/${itemId}.json`)
        .then(res => {
          const resJsonPromise = res.json()
          resJsonPromise.then(resJson => {
            client.set(itemId, JSON.stringify(resJson))
            client.set(itemId + ":time", Date.now())
          })
          return resJsonPromise
        })
    if (override_cache) {
      return itemFetchPromise
    }
    return Promise.all([
      getAsync(itemId),
      getAsync(itemId + ":time")
    ]).then((data) => {
      if (data[0] === null || Date.now() - Number(data[1]) > CACHING_INTERVAL) {
        return itemFetchPromise
      }
      return JSON.parse(data[0])
    }).catch(err => {
      console.error(err)
      return itemFetchPromise
    })
  }
  return null
}

function fetchItems(itemIds, args, override_cache=false) {
  return Promise.all(itemIds.map(itemId => fetchItem(itemId, override_cache)))
}

function fetchUser(userId, override_cache=false) {
  if (userId) {
    const userFetchPromise =
      retryFetch(`${baseURL}/user/${userId}.json`)
        .then(res => {
          const resJsonPromise = res.json()
          resJsonPromise.then(resJson => {
            client.set(userId, JSON.stringify(resJson))
            client.set(userId + ":time", Date.now())
          })
          return resJsonPromise
        })
    if (override_cache) {
      return userFetchPromise
    }
    return Promise.all([
      getAsync(userId),
      getAsync(userId + ":time")
    ]).then((data) => {
      if (data[0] === null || Date.now() - Number(data[1]) > CACHING_INTERVAL) {
        return userFetchPromise
      }
      return JSON.parse(data[0])
    }).catch(err => {
      console.error(err)
      return userFetchPromise
    })
  }
  return null
}

function updateCache() {
  console.log("updating cache")
  const categories = [
    "topstories",
    "newstories",
    "beststories",
    "askstories",
    "showstories",
    "jobstories"
  ]
  Promise.all(categories.map(category => {
    return fetchStories({category: category}, true).then(storyIds => {
      return fetchItems(storyIds.edges, {}, true).then(stories => {
        return Promise.all(stories.map(story => {
          if (story.kids) {
            return fetchItems(story.kids, {}, true)
          }
        }))
      })
    })
  })).then(res => {
    console.log("cache fetch finished")
  })
}

setInterval(() => {
  client.flushall()
}, 3600000)
client.flushall()

setInterval(updateCache, CACHING_INTERVAL)
updateCache()

const server = new GraphQLServer({
  typeDefs: './schema.graphql',
  resolvers,
})

server.start(() => console.log(`Server is running on http://localhost:4000`))
