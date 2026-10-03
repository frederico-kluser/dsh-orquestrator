'use strict'

const { parseConfig } = require('./config')
const { slugify } = require('./util')

function run(text) {
  const config = parseConfig(text)
  return { config, slug: slugify(config.title ?? '') }
}

module.exports = { run }
