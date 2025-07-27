// @ts-check

import { debug, getInput, info } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { Octokit } from '@octokit/action'

import { readFileSync } from 'node:fs'
import { env } from 'node:process'
import parseGitDiff from 'parse-git-diff'

/**
 * Generate suggestion body from changes, filtering out deleted lines
 * @param {Array} changes - Array of change objects with type and content
 * @returns {string} - Formatted suggestion body
 */
export const generateSuggestionBody = (changes) => {
  const suggestionBody = changes
    .filter(({ type }) => type === 'AddedLine' || type === 'UnchangedLine')
    .map(({ content }) => content)
    .join('\n')
  // Quadruple backticks allow for triple backticks in a fenced code block in the suggestion body
  // https://docs.github.com/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks#fenced-code-blocks
  return `\`\`\`\`suggestion\n${suggestionBody}\n\`\`\`\``
}

/**
 * Create a single line comment
 * @param {string} path - File path
 * @param {Object} toFileRange - Range in the current file state
 * @param {Array} changes - Array of changes
 * @returns {Object} - Comment object for GitHub API
 */
export function createSingleLineComment(path, toFileRange, changes) {
  return {
    path,
    line: toFileRange.start,
    body: generateSuggestionBody(changes),
  }
}

/**
 * Create a multi-line comment
 * @param {string} path - File path
 * @param {Object} toFileRange - Range in the current file state
 * @param {Array} changes - Array of changes
 * @returns {Object} - Comment object for GitHub API
 */
export function createMultiLineComment(path, toFileRange, changes) {
  return {
    path,
    start_line: toFileRange.start,
    // The last line of the chunk is the start line plus the number of lines in the chunk
    // minus 1 to account for the start line being included in toFileRange.lines
    line: toFileRange.start + toFileRange.lines - 1,
    start_side: 'RIGHT',
    side: 'RIGHT',
    body: generateSuggestionBody(changes),
  }
}

/**
 * Check if changes contain non-deleted content
 * @param {Array} changes - Array of change objects
 * @returns {boolean} - True if there are AddedLine or UnchangedLine changes
 */
export function hasNonDeletedContent(changes) {
  return changes.some(
    (change) => change.type === 'AddedLine' || change.type === 'UnchangedLine'
  )
}

/**
 * Generate a unique key for a comment
 * @param {Object} comment - Comment object
 * @returns {string} - Unique comment key
 */
export const generateCommentKey = (comment) =>
  `${comment.path}:${comment.line ?? ''}:${comment.start_line ?? ''}:${
    comment.body
  }`

/**
 * Validates the event value to ensure it matches one of the allowed types
 * @param {string} event - The event value to validate
 * @returns {"APPROVE" | "REQUEST_CHANGES" | "COMMENT"} - The validated event value
 */
export function validateEvent(event) {
  const allowedEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']
  if (!allowedEvents.includes(event)) {
    throw new Error(
      `Invalid event: ${event}. Allowed values are ${allowedEvents.join(', ')}.`
    )
  }
  return /** @type {"APPROVE" | "REQUEST_CHANGES" | "COMMENT"} */ (event)
}

/**
 * Process a chunk and create a comment if valid
 * @param {string} path - File path
 * @param {Object} chunk - Chunk object
 * @param {Set} existingCommentKeys - Set of existing comment keys
 * @returns {Array} - Array containing comment or empty array
 */
export function processChunk(path, chunk, existingCommentKeys) {
  // Check if the chunk has changes property
  if (!('changes' in chunk) || !chunk.toFileRange) {
    return []
  }

  const { toFileRange, changes } = chunk

  debug(`Starting line: ${toFileRange.start}`)
  debug(`Number of lines: ${toFileRange.lines}`)
  debug(`Changes: ${JSON.stringify(changes)}`)

  // Skip chunks that only contain deletions (no suggestions possible)
  if (!hasNonDeletedContent(changes)) {
    debug('Skipping chunk with only deletions')
    return []
  }

  const comment =
    toFileRange.lines <= 1
      ? createSingleLineComment(path, toFileRange, changes)
      : createMultiLineComment(path, toFileRange, changes)

  // Generate key for the new comment
  const commentKey = generateCommentKey(comment)

  // Check if the new comment already exists
  if (existingCommentKeys.has(commentKey)) {
    return []
  }

  return [comment]
}

/**
 * Main execution function
 */
export async function run() {
  const octokit = new Octokit({
    userAgent: 'suggest-changes',
  })

  const [owner, repo] = String(env.GITHUB_REPOSITORY).split('/')

  const eventPayload = JSON.parse(
    readFileSync(String(env.GITHUB_EVENT_PATH), 'utf8')
  )

  // Handle both pull_request and issue_comment events
  let pull_number
  let isCommentEvent = false
  if (eventPayload.pull_request) {
    // pull_request event
    pull_number = Number(eventPayload.pull_request.number)
  } else if (eventPayload.issue) {
    // issue_comment event - could be on issue or pull request
    // GitHub treats pull requests as issues, so we use issue.number
    pull_number = Number(eventPayload.issue.number)
    isCommentEvent = true
  } else {
    throw new Error('Event payload must contain either pull_request or issue')
  }

  const pullRequestFiles = (
    await octokit.pulls.listFiles({ owner, repo, pull_number })
  ).data.map((file) => file.filename)

  info(`Found ${pullRequestFiles.length} files in PR: ${pullRequestFiles.join(', ')}`)

  // Get the diff between the current working directory and HEAD (for working directory changes)
  // This works for both pull_request events (where we're on the PR branch) and 
  // issue_comment events (where changes have been generated in the working directory)
  const diff = await getExecOutput(
    'git',
    ['diff', '--unified=1', '--', ...pullRequestFiles],
    { silent: true }
  )

  debug(`Diff output: ${diff.stdout}`)

  // Check if there are any changes in the diff
  if (!diff.stdout || diff.stdout.trim() === '') {
    debug('No changes found in diff output, skipping review creation')
    return
  }

  // Create an array of changes from the diff output based on patches
  const parsedDiff = parseGitDiff(diff.stdout)

  // Get changed files from parsedDiff (changed files have type 'ChangedFile')
  const changedFiles = parsedDiff.files.filter(
    (file) => file.type === 'ChangedFile'
  )

  info(`Found ${changedFiles.length} changed files with diffs: ${changedFiles.map(f => f.path).join(', ')}`)

  // Exit early if no changed files
  if (changedFiles.length === 0) {
    debug('No changed files found, skipping review creation')
    return
  }

  // Fetch existing review comments
  const existingComments = (
    await octokit.pulls.listReviewComments({ owner, repo, pull_number })
  ).data

  // Create a Set of existing comment keys for faster lookup
  const existingCommentKeys = new Set(existingComments.map(generateCommentKey))

  // Create an array of comments with suggested changes for each chunk of each changed file
  const comments = changedFiles.flatMap(({ path, chunks }) => {
    const fileComments = chunks.flatMap((chunk) => processChunk(path, chunk, existingCommentKeys))
    if (fileComments.length > 0) {
      info(`Created ${fileComments.length} suggestion(s) for ${path}`)
    }
    return fileComments
  })

  // Create a review with the suggested changes if there are any
  if (comments.length > 0) {
    info(`Submitting review with ${comments.length} total suggestion(s)`)
    const event = validateEvent(getInput('event').toUpperCase() || 'COMMENT')
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      event,
      body: getInput('comment'),
      comments,
    })
    info('Review submitted successfully')
  } else {
    info('No suggestions to submit - all potential suggestions already exist or no valid changes found')
  }
}

// Run the main function when this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await run()
}
