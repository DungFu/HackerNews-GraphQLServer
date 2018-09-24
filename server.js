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
const Redis = require("ioredis")
const redis = new Redis()

const baseURL = 'https://hacker-news.firebaseio.com/v0'
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
    comments: (parent, args) => filterFirstAfter(parent.comments, args),
    user: parent => fetchUser(parent.user),
    user_id: parent => parent.user,
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
    let items;
    if (args.first > 0) {
      items = arr.slice(startIndex, startIndex + args.first)
    } else {
      items = arr.slice(startIndex)
    }
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
          if (resJson === null) {
            return;
          }
          redis.pipeline()
            .set(args.category, JSON.stringify(resJson))
            .set(args.category + ":time", Date.now())
            .exec()
        })
        return resJsonPromise
      })
  if (override_cache) {
    return storiesFetchPromise.then(storiesJson => {
      return filterFirstAfter(storiesJson, args)
    })
  }
  return redis.get(args.category + ":time").then(timestamp => {
    if (timestamp === null || Date.now() - Number(timestamp) > CACHING_INTERVAL) {
      return storiesFetchPromise
    }
    return redis.get(args.category).then(data => {
      if (data === null) {
        return storiesFetchPromise
      }
      return JSON.parse(data)
    })
  }).then(storiesJson => {
    return filterFirstAfter(storiesJson, args)
  })
}

function parseRecursiveComments(comments, pipeline) {
  return comments.map(comment => {
    const subComments = comment.comments
    comment.comments = subComments.map(comment => comment.id)
    pipeline.set(comment.id, JSON.stringify(comment))
    pipeline.set(comment.id + ":time", Date.now())
    parseRecursiveComments(subComments, pipeline)
    return comment.id
  })
}

function fetchItem(itemId, override_cache=false) {
  if (itemId) {
    const itemFetchPromise =
      retryFetch(`https://api.hnpwa.com/v0/item/${itemId}.json`)
        .then(res => {
          const resJsonPromise = res.json()
          resJsonPromise.then(resJson => {
            if (resJson === null) {
              return;
            }
            const pipeline = redis.pipeline()
            const subComments = resJson.comments
            resJson.comments = parseRecursiveComments(subComments, pipeline)
            pipeline.set(itemId, JSON.stringify(resJson))
            pipeline.set(itemId + ":time", Date.now())
            pipeline.exec()
          })
          return resJsonPromise
        })
    if (override_cache) {
      return itemFetchPromise
    }
    return redis.get(itemId + ":time").then(timestamp => {
      if (timestamp === null || Date.now() - Number(timestamp) > CACHING_INTERVAL) {
        return itemFetchPromise
      }
      return redis.get(itemId).then(data => {
        if (data === null) {
          return itemFetchPromise
        }
        return JSON.parse(data)
      })
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
            if (resJson === null) {
              return;
            }
            redis.pipeline()
              .set(userId, JSON.stringify(resJson))
              .set(userId + ":time", Date.now())
              .exec()
          })
          return resJsonPromise
        })
    if (override_cache) {
      return userFetchPromise
    }
    return redis.get(userId + ":time").then(timestamp => {
      if (timestamp === null || Date.now() - Number(timestamp) > CACHING_INTERVAL) {
        return userFetchPromise
      }
      return redis.get(userId).then(data => {
        if (data === null) {
          return userFetchPromise
        }
        return JSON.parse(data)
      })
    })
  }
  return null
}

function updateCache() {
  console.log("updating cache...")
  const categories = [
    "topstories",
    // "newstories",
    "beststories",
    // "askstories",
    // "showstories",
    // "jobstories"
  ]
  for (let category of categories) {
    fetchStories({category: category, first: 30}, true).then(storyIds => {
      return fetchItems(storyIds.edges, {}, true)
    }).then(res => {
      console.log("cache fetch finished " + category)
    })
  }
}

setInterval(() => {
  redis.flushall()
}, 3600000)
redis.flushall()

setInterval(updateCache, CACHING_INTERVAL)
updateCache()

const server = new GraphQLServer({
  typeDefs: './schema.graphql',
  resolvers,
})

server.start(() => console.log(`Server is running on http://localhost:4000`))
