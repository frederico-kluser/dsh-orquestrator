'use strict'

/** Lowercase, replace runs of non-alphanumerics with '-', trim '-' from both ends. */
function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

module.exports = { slugify }
