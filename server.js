const { GraphQLServer } = require('graphql-yoga')
const fetch = require('node-fetch')

const baseURL = 'https://hacker-news.firebaseio.com/v0'
const MAX_FETCH_NUM = 20
const cacheStories = {}
const cacheItems = {}
const cacheUsers = {}

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

function fetchStories(args) {
  const now = Date.now()
  let storiesPromise;
  if (cacheStories[args.category] && now - cacheStories[args.category][0] < 60000) {
    storiesPromise = new Promise(function(resolve, reject){
      resolve(cacheStories[args.category][1])
    })
  } else {
    storiesPromise = fetch(`${baseURL}/${args.category}.json`)
      .then(res => {
        cacheStories[args.category] = [now, res.json()]
        return cacheStories[args.category][1]
      })
  }
  return storiesPromise.then(storiesJson => {
    return filterFirstAfter(storiesJson, args)
  })
}

function fetchItem(itemId) {
  if (itemId) {
    const now = Date.now()
    if (cacheItems[itemId] && now - cacheItems[itemId][0] < 60000) {
      return new Promise(function(resolve, reject){
        resolve(cacheItems[itemId][1])
      })
    }
    return fetch(`${baseURL}/item/${itemId}.json`)
      .then(res => {
        cacheItems[itemId] = [now, res.json()]
        return cacheItems[itemId][1]
      })
  }
  return null
}

function fetchItems(itemIds, args) {
  return Promise.all(itemIds.map(itemId => fetchItem(itemId)))
}

function fetchUser(userId) {
  if (userId) {
    const now = Date.now()
    if (cacheUsers[userId] && now - cacheUsers[userId][0] < 60000) {
      return new Promise(function(resolve, reject){
        resolve(cacheUsers[userId][1])
      })
    }
    return fetch(`${baseURL}/user/${userId}.json`)
      .then(res => {
        cacheUsers[userId] = [now, res.json()]
        return cacheUsers[userId][1]
      })
  }
  return null
}

const server = new GraphQLServer({
  typeDefs: './schema.graphql',
  resolvers,
})

server.start(() => console.log(`Server is running on http://localhost:4000`))
