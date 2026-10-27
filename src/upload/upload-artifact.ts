import * as core from '@actions/core'
import artifact, {
  UploadArtifactOptions,
  ArtifactNotFoundError
} from '@actions/artifact'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {findFilesToUpload} from '../shared/search.js'
import {getInputs} from './input-helper.js'
import {NoFileOptions} from './constants.js'
import {uploadArtifact} from '../shared/upload-artifact.js'

export const MANIFEST_PREFIX = '.artifact_upload_manifest.'
export const MANIFEST_SUFFIX = '.json'

export const getManifestName = (groupName: string): string =>
  `${MANIFEST_PREFIX}${groupName}${MANIFEST_SUFFIX}`

const isManifestName = (name: string): boolean =>
  name.startsWith(MANIFEST_PREFIX) &&
  name.endsWith(MANIFEST_SUFFIX) &&
  name.length > MANIFEST_PREFIX.length + MANIFEST_SUFFIX.length

export interface ManifestEntry {
  artifact: string
  path: string
}

async function deleteArtifactIfExists(artifactName: string): Promise<void> {
  try {
    await artifact.deleteArtifact(artifactName)
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      core.debug(`Skipping deletion of '${artifactName}', it does not exist`)
      return
    }

    // Best effort, we don't want to fail the action if this fails
    core.debug(`Unable to delete artifact: ${(error as Error).message}`)
  }
}

/**
 * Builds a flat artifact name per file by joining its path segments with `_`
 * (e.g. `tests/folder1/a.txt` -> `tests_folder1_a.txt`). Paths are relative to
 * the workspace when the file is inside it, otherwise to the search root.
 * Throws if two files map to the same name.
 */
export function getUnarchivedArtifactNames(
  files: string[],
  rootDirectory: string,
  manifestName: string
): ManifestEntry[] {
  const workspace = path.resolve(
    process.env['GITHUB_WORKSPACE'] || process.cwd()
  )
  const owners = new Map<string, string>([[manifestName, 'the manifest']])

  return files.map(file => {
    let relative = path.relative(workspace, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      relative = path.relative(rootDirectory, file)
    }
    const segments = relative.split(/[\\/]+/).filter(Boolean)
    const name = segments.join('_')

    if (isManifestName(name)) {
      throw new Error(
        `'${file}' would be uploaded as '${name}', which is reserved for upload manifests. No artifacts were uploaded.`
      )
    }
    const existing = owners.get(name)
    if (existing !== undefined) {
      throw new Error(
        `Artifact name collision: '${existing}' and '${file}' would both be uploaded as '${name}'. No artifacts were uploaded.`
      )
    }
    owners.set(name, file)
    return {artifact: name, path: segments.join('/')}
  })
}

/**
 * Without `overwrite`, fail up front if any target name is already taken in
 * this run so we never leave a partial set of artifacts behind. Best effort:
 * if listing fails, the upload itself still rejects duplicates.
 */
async function findExistingArtifacts(names: string[]): Promise<string[]> {
  try {
    const {artifacts} = await artifact.listArtifacts({latest: true})
    const taken = new Set(artifacts.map(a => a.name))
    return names.filter(n => taken.has(n))
  } catch (error) {
    core.debug(`Unable to list existing artifacts: ${(error as Error).message}`)
    return []
  }
}

/**
 * With skipArchive the artifact client ignores the requested name and uses the
 * file's basename, so stage the file under its combined name first. A hard link
 * avoids copying large files; fall back to a copy across volumes.
 */
async function uploadRenamed(
  artifactName: string,
  file: string,
  options: UploadArtifactOptions
): Promise<void> {
  const dir = await fs.mkdtemp(
    path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 'upload-staging-')
  )
  try {
    const staged = path.join(dir, artifactName)
    try {
      await fs.link(file, staged)
      core.debug(`Hard-linked '${file}' as '${staged}'`)
    } catch (error) {
      core.debug(
        `Unable to hard-link '${file}' (${(error as Error).message}); copying instead`
      )
      await fs.copyFile(file, staged)
    }
    await uploadArtifact(artifactName, [staged], dir, options)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
}

/**
 * Uploads a manifest artifact mapping each artifact name to its original
 * relative path so download-artifact can restore the directory structure.
 */
async function uploadManifest(
  manifestName: string,
  entries: ManifestEntry[],
  options: UploadArtifactOptions
): Promise<void> {
  const dir = await fs.mkdtemp(
    path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 'upload-manifest-')
  )
  try {
    const manifestFile = path.join(dir, manifestName)
    await fs.writeFile(
      manifestFile,
      JSON.stringify({version: 1, files: entries}, null, 2)
    )
    await uploadArtifact(manifestName, [manifestFile], dir, options)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
}

export async function run(): Promise<void> {
  const inputs = getInputs()
  const searchResult = await findFilesToUpload(
    inputs.searchPath,
    inputs.includeHiddenFiles
  )
  if (searchResult.filesToUpload.length === 0) {
    // No files were found, different use cases warrant different types of behavior if nothing is found
    switch (inputs.ifNoFilesFound) {
      case NoFileOptions.warn: {
        core.warning(
          `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
        )
        break
      }
      case NoFileOptions.error: {
        core.setFailed(
          `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
        )
        break
      }
      case NoFileOptions.ignore: {
        core.info(
          `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
        )
        break
      }
    }
  } else {
    const s = searchResult.filesToUpload.length === 1 ? '' : 's'
    core.info(
      `With the provided path, there will be ${searchResult.filesToUpload.length} file${s} uploaded`
    )
    core.debug(`Root artifact directory is ${searchResult.rootDirectory}`)

    const options: UploadArtifactOptions = {}
    if (inputs.retentionDays) {
      options.retentionDays = inputs.retentionDays
    }

    if (typeof inputs.compressionLevel !== 'undefined') {
      options.compressionLevel = inputs.compressionLevel
    }

    if (!inputs.archive && searchResult.filesToUpload.length > 1) {
      // Each file becomes its own artifact; validate all names before uploading anything
      const manifestName = getManifestName(inputs.artifactName)
      let entries: ManifestEntry[]
      try {
        entries = getUnarchivedArtifactNames(
          searchResult.filesToUpload,
          searchResult.rootDirectory,
          manifestName
        )
      } catch (error) {
        core.setFailed((error as Error).message)
        return
      }

      if (!inputs.overwrite) {
        const taken = await findExistingArtifacts([
          ...entries.map(e => e.artifact),
          manifestName
        ])
        if (taken.length > 0) {
          core.error(
            `These artifact names are already used in this run: ${taken.join(', ')}`
          )
          core.setFailed(
            `Artifact(s) already exist in this run: ${taken.join(', ')}. No artifacts were uploaded. Set 'overwrite: true' to replace them.`
          )
          return
        }
      }

      options.skipArchive = true
      core.info(
        `Uploading ${entries.length} files as separate artifacts, plus manifest '${manifestName}'`
      )
      for (let i = 0; i < entries.length; i++) {
        core.info(
          `[${i + 1}/${entries.length}] ${entries[i].path} -> artifact '${entries[i].artifact}'`
        )
        if (inputs.overwrite) {
          await deleteArtifactIfExists(entries[i].artifact)
        }
        await uploadRenamed(
          entries[i].artifact,
          searchResult.filesToUpload[i],
          options
        )
      }

      // Uploaded last so its presence implies every file above succeeded
      core.info(`Uploading manifest '${manifestName}'`)
      if (inputs.overwrite) {
        await deleteArtifactIfExists(manifestName)
      }
      await uploadManifest(manifestName, entries, options)
      return
    }

    if (inputs.overwrite) {
      await deleteArtifactIfExists(inputs.artifactName)
    }

    if (!inputs.archive) {
      options.skipArchive = true
    }

    await uploadArtifact(
      inputs.artifactName,
      searchResult.filesToUpload,
      searchResult.rootDirectory,
      options
    )
  }
}
