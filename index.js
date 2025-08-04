// @ts-check

import { debug, getInput, info, setOutput } from '@actions/core'
import { getExecOutput } from '@actions/exec'
import { Octokit } from '@octokit/action'

import { readFileSync } from 'node:fs'
import { env } from 'node:process'
import parseGitDiff from 'parse-git-diff'

/** @typedef {import('parse-git-diff').AnyLineChange} AnyLineChange */
/** @typedef {import('parse-git-diff').AddedLine} AddedLine */
/** @typedef {import('parse-git-diff').DeletedLine} DeletedLine */
/** @typedef {import('parse-git-diff').UnchangedLine} UnchangedLine */
/** @typedef {import('@octokit/types').Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/comments']['response']['data'][number]} GetReviewComment */
/** @typedef {NonNullable<import('@octokit/types').Endpoints['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews']['parameters']['comments']>[number]} PostReviewComment */
/** @typedef {import("@octokit/webhooks-types").PullRequestEvent} PullRequestEvent */
/** @typedef {import('@octokit/types').Endpoints['POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews']['parameters']['event']} ReviewEvent */

/**
 * @typedef {Object} SuggestionBody
 * @property {string} body
 * @property {number} lineCount
 */

/**
 * Type guard to check if a change is an AddedLine
 * @param {AnyLineChange} change - The change to check
 * @returns {change is AddedLine} True if the change is an AddedLine
 */
function isAddedLine(change) {
  return change?.type === 'AddedLine' && typeof change.lineAfter === 'number'
}

/**
 * Type guard to check if a change is a DeletedLine
 * @param {AnyLineChange} change - The change to check
 * @returns {change is DeletedLine} True if the change is a DeletedLine
 */
function isDeletedLine(change) {
  return change?.type === 'DeletedLine' && typeof change.lineBefore === 'number'
}

/**
 * Type guard to check if a change is an UnchangedLine
 * @param {AnyLineChange} change - The change to check
 * @returns {change is UnchangedLine} True if the change is an UnchangedLine
 */
function isUnchangedLine(change) {
  return (
    change?.type === 'UnchangedLine' &&
    typeof change.lineBefore === 'number' &&
    typeof change.lineAfter === 'number'
  )
}

/**
 * Generate git diff output with consistent flags
 * @param {string[]} gitArgs - Additional git diff arguments
 * @returns {Promise<string>} The git diff output
 */
export async function getGitDiff(gitArgs) {
  const result = await getExecOutput(
    'git',
    ['diff', '--unified=1', '--ignore-cr-at-eol', ...gitArgs],
    { silent: true, ignoreReturnCode: true }
  )
  return result.stdout
}

/**
 * @param {string} content
 * @returns {string}
 */
export const createSuggestion = (content) => {
  // Quadruple backticks allow for triple backticks in a fenced code block in the suggestion body
  // https://docs.github.com/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks#fenced-code-blocks
  return `\`\`\`\`suggestion\n${content}\n\`\`\`\``
}

/**
 * Filter changes by type for easier processing
 * @param {AnyLineChange[]} changes - Array of changes to filter
 * @returns {{addedLines: AddedLine[], deletedLines: DeletedLine[], unchangedLines: UnchangedLine[]}}
 */
const filterChangesByType = (changes) => ({
  addedLines: changes.filter(isAddedLine),
  deletedLines: changes.filter(isDeletedLine),
  unchangedLines: changes.filter(isUnchangedLine),
})

/**
 * Group changes into logical suggestion groups based on line proximity.
 *
 * Groups contiguous or nearly contiguous changes together to create logical
 * suggestions that make sense when reviewing code. Unchanged lines are included
 * for context but don't affect contiguity calculations.
 *
 * @param {AnyLineChange[]} changes - Array of line changes from git diff
 * @returns {AnyLineChange[][]} Array of suggestion groups
 */
export const groupChangesForSuggestions = (changes) => {
  if (changes.length === 0) return []

  // Group by line proximity using appropriate coordinate systems
  // - Deletions use lineBefore (original file line numbers)
  // - Additions use lineAfter (new file line numbers)
  // - Unchanged use lineBefore (context positioning)
  const groups = []
  let currentGroup = []
  let lastChangedLineNumber = null

  for (const change of changes) {
    const lineNumber = isDeletedLine(change)
      ? change.lineBefore
      : isAddedLine(change)
      ? change.lineAfter
      : isUnchangedLine(change)
      ? change.lineBefore
      : null

    if (lineNumber === null) continue

    // Start new group if there's a line gap between actual changes (not unchanged lines)
    if (
      !isUnchangedLine(change) &&
      lastChangedLineNumber !== null &&
      lineNumber > lastChangedLineNumber + 1
    ) {
      groups.push(currentGroup)
      currentGroup = []
    }

    currentGroup.push(change)

    // Only track line numbers for actual changes (deletions and additions)
    if (!isUnchangedLine(change)) {
      lastChangedLineNumber = lineNumber
    }
  }

  if (currentGroup.length > 0) groups.push(currentGroup)

  return groups
}

/**
 * Generate suggestion body and line count for a group of changes
 * @param {AnyLineChange[]} changes - Group of related changes
 * @returns {SuggestionBody | null} Suggestion body and line count, or null if no suggestion needed
 */
export const generateSuggestionBody = (changes) => {
  const { addedLines, deletedLines, unchangedLines } =
    filterChangesByType(changes)

  // No additions means no content to suggest, except for pure deletions
  if (addedLines.length === 0) {
    return deletedLines.length > 0
      ? { body: createSuggestion(''), lineCount: deletedLines.length }
      : null
  }

  // Pure additions: include context if available
  if (deletedLines.length === 0) {
    const hasContext = unchangedLines.length > 0
    const suggestionLines = hasContext
      ? [unchangedLines[0].content, ...addedLines.map((line) => line.content)]
      : addedLines.map((line) => line.content)

    return {
      body: createSuggestion(suggestionLines.join('\n')),
      lineCount: hasContext ? 1 : addedLines.length,
    }
  }

  // Mixed changes: replace deleted content with added content
  const suggestionLines = addedLines.map((line) => line.content)
  return {
    body: createSuggestion(suggestionLines.join('\n')),
    lineCount: Math.max(deletedLines.length, addedLines.length),
  }
}

/**
 * Calculate line positioning for GitHub review comments.
 * @param {AnyLineChange[]} groupChanges - The changes in this group
 * @param {number} lineCount - Number of lines the suggestion spans
 * @param {{start: number}} fromFileRange - File range information
 * @returns {{startLine: number, endLine: number}} Line positioning
 */
export const calculateLinePosition = (
  groupChanges,
  lineCount,
  fromFileRange
) => {
  // Try to find the best target line in order of preference
  const firstDeletedLine = groupChanges.find(isDeletedLine)
  const firstUnchangedLine = groupChanges.find(isUnchangedLine)

  const startLine =
    firstDeletedLine?.lineBefore ?? // Deletions: use original line
    firstUnchangedLine?.lineBefore ?? // Pure additions with context: position on context line
    fromFileRange.start // Pure additions without context: use file range

  return { startLine, endLine: startLine + lineCount - 1 }
}

/**
 * Function to generate a unique key for a comment
 * @param {PostReviewComment | GetReviewComment} comment
 * @returns {string}
 */
export const generateCommentKey = (comment) =>
  `${comment.path}:${comment.line ?? ''}:${comment.start_line ?? ''}:${
    comment.body
  }`

/**
 * Generate GitHub review comments from a parsed diff (exported for testing)
 * @param {ReturnType<typeof parseGitDiff>} parsedDiff - Parsed diff from parse-git-diff
 * @param {Set<string>} existingCommentKeys - Set of existing comment keys to avoid duplicates
 * @returns {Array<{path: string, body: string, line: number, start_line?: number, start_side?: string}>} Generated comments
 */
export function generateReviewComments(
  parsedDiff,
  existingCommentKeys = new Set()
) {
  return parsedDiff.files
    .filter((file) => file.type === 'ChangedFile')
    .flatMap(({ path, chunks }) =>
      chunks
        .filter((chunk) => chunk.type === 'Chunk')
        .flatMap(({ fromFileRange, changes }) =>
          processChunkChanges(path, fromFileRange, changes, existingCommentKeys)
        )
    )
}

/**
 * Process changes within a chunk to generate review comments
 * @param {string} path - File path
 * @param {{start: number}} fromFileRange - File range information
 * @param {AnyLineChange[]} changes - Changes in the chunk
 * @param {Set<string>} existingCommentKeys - Set of existing comment keys
 * @returns {Array<{path: string, body: string, line: number, start_line?: number, start_side?: string}>} Generated comments
 */
const processChunkChanges = (
  path,
  fromFileRange,
  changes,
  existingCommentKeys
) => {
  const suggestionGroups = groupChangesForSuggestions(changes)

  return suggestionGroups.flatMap((groupChanges) => {
    const suggestionBody = generateSuggestionBody(groupChanges)

    // Skip if no suggestion was generated
    if (!suggestionBody) return []

    const { body, lineCount } = suggestionBody
    const { startLine, endLine } = calculateLinePosition(
      groupChanges,
      lineCount,
      fromFileRange
    )

    // Create comment with conditional multi-line properties
    const comment = {
      path,
      body,
      line: endLine,
      ...(lineCount > 1 && { start_line: startLine, start_side: 'RIGHT' }),
    }

    // Skip if comment already exists
    const commentKey = generateCommentKey(comment)
    return existingCommentKeys.has(commentKey) ? [] : [comment]
  })
}

/**
 * Main execution function for the GitHub Action
 * @param {Object} options - Configuration options
 * @param {Octokit} options.octokit - Octokit instance
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {number} options.pull_number - Pull request number
 * @param {string} options.commit_id - Commit SHA
 * @param {string} options.diff - Git diff output
 * @param {ReviewEvent} options.event - Review event type
 * @param {string} options.body - Review body
 * @returns {Promise<{comments: Array, reviewCreated: boolean}>} Result of the action
 */
export async function run({
  octokit,
  owner,
  repo,
  pull_number,
  commit_id,
  diff,
  event,
  body,
}) {
  debug(`Diff output: ${diff}`)

  const parsedDiff = parseGitDiff(diff)

  const existingComments = (
    await octokit.pulls.listReviewComments({ owner, repo, pull_number })
  ).data

  const existingCommentKeys = new Set(existingComments.map(generateCommentKey))

  const comments = generateReviewComments(parsedDiff, existingCommentKeys)
  
  console.log(`📝 Generated ${comments.length} review comments`)
  if (comments.length > 0) {
    debug('Comments to submit:')
    comments.forEach(c => debug(`  - ${c.path}:${c.line} (${c.start_line ? `lines ${c.start_line}-${c.line}` : 'single line'})`))
  }

  // Create a review with the suggested changes if there are any
  if (comments.length > 0) {
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        commit_id,
        body,
        event,
        comments,
      })
      console.log(`✅ Successfully created review with ${comments.length} comments`)
      return { comments, reviewCreated: true, failedComments: [] }
    } catch (error) {
      console.error('❌ Failed to create review with all comments:', error.message)
      
      // If the error is about invalid line numbers, try to submit comments individually
      if (error.status === 422 && 
          (error.message.includes('line must be part of the diff') || 
           error.message.includes('Pull request review thread line must be part of the diff') ||
           error.message.includes("diff hunk can't be blank"))) {
        console.log('📝 Attempting to submit comments individually...')
        
        const failedComments = []
        const successfulComments = []
        
        for (const comment of comments) {
          try {
            await octokit.pulls.createReview({
              owner,
              repo,
              pull_number,
              commit_id,
              body: `Individual suggestion for ${comment.path}`,
              event,
              comments: [comment],
            })
            successfulComments.push(comment)
            console.log(`✅ Successfully submitted comment for ${comment.path}:${comment.line}`)
          } catch (individualError) {
            failedComments.push({
              comment,
              error: individualError.message
            })
            console.error(`❌ Failed to submit comment for ${comment.path}:${comment.line}: ${individualError.message}`)
          }
        }
        
        console.log(`📊 Summary: ${successfulComments.length} successful, ${failedComments.length} failed`)
        
        // If at least one comment succeeded, consider it a partial success
        if (successfulComments.length > 0) {
          return { 
            comments: successfulComments, 
            reviewCreated: true, 
            failedComments 
          }
        }
      }
      
      // If we couldn't submit any comments, log the error but don't fail the action
      console.error('❌ Could not submit any review comments')
      console.error('Error details:', error)
      return { comments: [], reviewCreated: false, failedComments: comments }
    }
  }

  return { comments, reviewCreated: false, failedComments: [] }
}

// Only run main logic when this file is executed directly (not when imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const octokit = new Octokit({
      userAgent: 'suggest-changes',
    })

    const [owner, repo] = String(env.GITHUB_REPOSITORY).split('/')

    const eventPayload = JSON.parse(
      readFileSync(String(env.GITHUB_EVENT_PATH), 'utf8')
    )
    
    // Determine the event type and extract PR information accordingly
    let pull_number, commit_id
    
    if (env.GITHUB_EVENT_NAME === 'issue_comment' && eventPayload.issue?.pull_request) {
      // This is a comment on a PR
      pull_number = Number(eventPayload.issue.number)
      
      // For issue_comment events, we need to fetch the PR data to get the commit SHA
      const pullRequest = await octokit.pulls.get({ owner, repo, pull_number })
      commit_id = pullRequest.data.head.sha
      
      console.log(`📋 Processing PR comment event for PR #${pull_number}`)
    } else if (eventPayload.pull_request) {
      // This is a direct PR event
      pull_number = Number(eventPayload.pull_request.number)
      commit_id = eventPayload.pull_request.head.sha
      
      console.log(`📋 Processing pull request event for PR #${pull_number}`)
    } else {
      throw new Error(`Unsupported event type: ${env.GITHUB_EVENT_NAME}. This action only supports pull_request and issue_comment events.`)
    }

    const pullRequestFiles = (
      await octokit.pulls.listFiles({ owner, repo, pull_number })
    ).data.map((file) => file.filename)

    // Get the diff between the head branch and the base branch (limit to the files in the pull request)
    const diff = await getGitDiff(['--', ...pullRequestFiles])

    const event = /** @type {ReviewEvent} */ (getInput('event').toUpperCase())
    const body = getInput('comment')

    try {
    const result = await run({
      octokit,
      owner,
      repo,
      pull_number,
      commit_id,
      diff,
      event,
      body,
    })
    
    // Log final summary
    if (result.failedComments && result.failedComments.length > 0) {
      console.log('\n📋 Failed Comments Summary:')
      result.failedComments.forEach(({ comment, error }) => {
        console.log(`  - ${comment.path}:${comment.line} - ${error}`)
      })
      
      // Set output for GitHub Actions
      setOutput('failed_comments_count', String(result.failedComments.length))
      setOutput('successful_comments_count', String(result.comments.length))
    }
    
    // Don't fail the action even if some comments failed
    console.log('\n✅ Action completed successfully (with potential partial failures)')
  } catch (error) {
    console.error('❌ Unexpected error in suggest-changes action:', error)
    // Still don't fail the action - just log the error
    console.log('⚠️  Action will complete with warnings rather than failing')
  }
  } catch (error) {
    console.error('❌ Critical error in suggest-changes action initialization:', error)
    console.error('Event type:', env.GITHUB_EVENT_NAME)
    console.error('Event payload structure:', JSON.stringify(eventPayload || {}, null, 2))
    console.log('⚠️  Action failed to initialize properly. Please check the event type and payload.')
    // Exit gracefully without throwing
    process.exit(0)
  }
}
