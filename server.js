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
          redis.set(args.category, JSON.stringify(resJson))
          redis.set(args.category + ":time", Date.now())
        })
        return resJsonPromise
      })
  if (override_cache) {
    return storiesFetchPromise.then(storiesJson => {
      return filterFirstAfter(storiesJson, args)
    })
  }
  return Promise.all([
    redis.get(args.category),
    redis.get(args.category + ":time")
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
            return pipeline.exec()
          })
          return resJsonPromise
        })
    if (override_cache) {
      return itemFetchPromise
    }
    return Promise.all([
      redis.get(itemId),
      redis.get(itemId + ":time")
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
      retryFetch(`https://api.hnpwa.com/v0/user/${userId}.json`)
        .then(res => {
          const resJsonPromise = res.json()
          resJsonPromise.then(resJson => {
            redis.set(userId, JSON.stringify(resJson))
            redis.set(userId + ":time", Date.now())
          })
          return resJsonPromise
        })
    if (override_cache) {
      return userFetchPromise
    }
    return Promise.all([
      redis.get(userId),
      redis.get(userId + ":time")
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
    return fetchStories({category: category, first: 30}, true).then(storyIds => {
      return fetchItems(storyIds.edges, {}, true)
    })
  })).then(res => {
    console.log("cache fetch finished")
  })
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
