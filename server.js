const { GraphQLServer } = require('graphql-yoga')
const fetch = require('node-fetch')

const baseURL = 'https://hacker-news.firebaseio.com/v0'
const MAX_FETCH_NUM = 20

const resolvers = {
  Query: {
    topstories: (parent, args) => fetchStories('topstories', args),
    newstories: (parent, args) => fetchStories('newstories', args),
    beststories: (parent, args) => fetchStories('beststories', args),
    askstories: (parent, args) => fetchStories('askstories', args),
    showstories: (parent, args) => fetchStories('showstories', args),
    jobstories: (parent, args) => fetchStories('jobstories', args),
    item: (parent, args) => fetchItem(args.id),
    user: (parent, args) => fetchUser(args.id),
  },
  Item: {
    kids: (parent, args) => fetchItems(parent.kids, args),
    parts: (parent, args) => fetchItems(parent.parts, args),
    by: parent => fetchUser(parent.by),
    parent: parent => fetchItem(parent.parent),
    poll: parent => fetchItem(parent.poll),
  },
  User: {
    submitted: (parent, args) => fetchItems(parent.submitted, args)
  }
}

function filterFirstAfter(arr, args) {
  let startIndex = 0
  if (args.after) {
    const index = arr.indexOf(Number(args.after))
    if (index >= 0) {
      startIndex = Math.min(index + 1, arr.length - 1);
    }
  }
  if (!(args.first <= MAX_FETCH_NUM)) {
    args.first = MAX_FETCH_NUM
  }
  return args.first > 0
    ? arr.slice(startIndex, startIndex + args.first)
    : arr.slice(startIndex)
}

function fetchStories(category, args) {
  return fetch(`${baseURL}/${category}.json`)
    .then(res => res.json())
    .then(storiesJson => {
      return Promise.all(
        filterFirstAfter(storiesJson, args)
          .map(itemId => fetchItem(itemId)))
    })
}

function fetchItem(itemId) {
  if (itemId) {
    return fetch(`${baseURL}/item/${itemId}.json`)
      .then(res => res.json())
  }
  return null
}

function fetchItems(itemIds, args) {
  if (itemIds) {
    return Promise.all(
      filterFirstAfter(itemIds, args)
        .map(itemId => fetchItem(itemId)))
  }
  return null
}

function fetchUser(userId) {
  if (userId) {
    return fetch(`${baseURL}/user/${userId}.json`)
      .then(res => res.json())
  }
  return null
}

const server = new GraphQLServer({
  typeDefs: './schema.graphql',
  resolvers,
})

server.start(() => console.log(`Server is running on http://localhost:4000`))
