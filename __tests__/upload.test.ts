import {jest, describe, test, expect, beforeEach} from '@jest/globals'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

// Mock @actions/github before importing modules that use it
jest.unstable_mockModule('@actions/github', () => ({
  context: {
    repo: {
      owner: 'actions',
      repo: 'toolkit'
    },
    runId: 123,
    serverUrl: 'https://github.com'
  },
  getOctokit: jest.fn()
}))

// Mock @actions/core
jest.unstable_mockModule('@actions/core', () => ({
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  setSecret: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  notice: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  isDebug: jest.fn(() => false),
  getState: jest.fn(),
  saveState: jest.fn(),
  exportVariable: jest.fn(),
  addPath: jest.fn(),
  group: jest.fn((name: string, fn: () => Promise<unknown>) => fn()),
  toPlatformPath: jest.fn((p: string) => p),
  toWin32Path: jest.fn((p: string) => p),
  toPosixPath: jest.fn((p: string) => p)
}))

// Mock shared search module
const mockFindFilesToUpload =
  jest.fn<() => Promise<{filesToUpload: string[]; rootDirectory: string}>>()
jest.unstable_mockModule('../src/shared/search.js', () => ({
  findFilesToUpload: mockFindFilesToUpload
}))

// Dynamic imports after mocking
const core = await import('@actions/core')
const github = await import('@actions/github')
const artifact = await import('@actions/artifact')
const {run} = await import('../src/upload/upload-artifact.js')
const {Inputs} = await import('../src/upload/constants.js')
const {ArtifactNotFoundError} = artifact

const fixtures = {
  artifactName: 'artifact-name',
  rootDirectory: '/some/artifact/path',
  filesToUpload: [
    '/some/artifact/path/file1.txt',
    '/some/artifact/path/file2.txt'
  ]
}

const mockInputs = (
  overrides?: Partial<{[K in (typeof Inputs)[keyof typeof Inputs]]?: any}>
) => {
  const inputs: Record<string, any> = {
    [Inputs.Name]: 'artifact-name',
    [Inputs.Path]: '/some/artifact/path',
    [Inputs.IfNoFilesFound]: 'warn',
    [Inputs.RetentionDays]: 0,
    [Inputs.CompressionLevel]: 6,
    [Inputs.Overwrite]: false,
    [Inputs.Archive]: true,
    ...overrides
  }

  ;(core.getInput as jest.Mock<typeof core.getInput>).mockImplementation(
    (name: string) => {
      return inputs[name]
    }
  )
  ;(
    core.getBooleanInput as jest.Mock<typeof core.getBooleanInput>
  ).mockImplementation((name: string) => {
    return inputs[name]
  })

  return inputs
}

describe('upload', () => {
  beforeEach(async () => {
    mockInputs()
    jest.clearAllMocks()

    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: fixtures.filesToUpload,
      rootDirectory: fixtures.rootDirectory
    })

    jest.spyOn(artifact.default, 'listArtifacts').mockResolvedValue({
      artifacts: []
    })

    jest.spyOn(artifact.default, 'uploadArtifact').mockResolvedValue({
      size: 123,
      id: 1337,
      digest: 'facefeed'
    })
  })

  test('uploads a single file', async () => {
    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [fixtures.filesToUpload[0]],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      [fixtures.filesToUpload[0]],
      fixtures.rootDirectory,
      {compressionLevel: 6}
    )
  })

  test('uploads multiple files', async () => {
    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      fixtures.filesToUpload,
      fixtures.rootDirectory,
      {compressionLevel: 6}
    )
  })

  test('sets outputs', async () => {
    await run()

    expect(core.setOutput).toHaveBeenCalledWith('artifact-id', 1337)
    expect(core.setOutput).toHaveBeenCalledWith('artifact-digest', 'facefeed')
    expect(core.setOutput).toHaveBeenCalledWith(
      'artifact-url',
      `${github.context.serverUrl}/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}/artifacts/${1337}`
    )
  })

  test('supports custom compression level', async () => {
    mockInputs({
      [Inputs.CompressionLevel]: 2
    })

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      fixtures.filesToUpload,
      fixtures.rootDirectory,
      {compressionLevel: 2}
    )
  })

  test('supports custom retention days', async () => {
    mockInputs({
      [Inputs.RetentionDays]: 7
    })

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      fixtures.filesToUpload,
      fixtures.rootDirectory,
      {retentionDays: 7, compressionLevel: 6}
    )
  })

  test('supports warn if-no-files-found', async () => {
    mockInputs({
      [Inputs.IfNoFilesFound]: 'warn'
    })

    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      `No files were found with the provided path: ${fixtures.rootDirectory}. No artifacts will be uploaded.`
    )
  })

  test('supports error if-no-files-found', async () => {
    mockInputs({
      [Inputs.IfNoFilesFound]: 'error'
    })

    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      `No files were found with the provided path: ${fixtures.rootDirectory}. No artifacts will be uploaded.`
    )
  })

  test('supports ignore if-no-files-found', async () => {
    mockInputs({
      [Inputs.IfNoFilesFound]: 'ignore'
    })

    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.info).toHaveBeenCalledWith(
      `No files were found with the provided path: ${fixtures.rootDirectory}. No artifacts will be uploaded.`
    )
  })

  test('supports overwrite', async () => {
    mockInputs({
      [Inputs.Overwrite]: true
    })

    jest.spyOn(artifact.default, 'deleteArtifact').mockResolvedValue({
      id: 1337
    })

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      fixtures.filesToUpload,
      fixtures.rootDirectory,
      {compressionLevel: 6}
    )

    expect(artifact.default.deleteArtifact).toHaveBeenCalledWith(
      fixtures.artifactName
    )
  })

  test('supports overwrite and continues if not found', async () => {
    mockInputs({
      [Inputs.Overwrite]: true
    })

    jest
      .spyOn(artifact.default, 'deleteArtifact')
      .mockRejectedValue(new ArtifactNotFoundError('not found'))

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      fixtures.filesToUpload,
      fixtures.rootDirectory,
      {compressionLevel: 6}
    )

    expect(artifact.default.deleteArtifact).toHaveBeenCalledWith(
      fixtures.artifactName
    )
    expect(core.debug).toHaveBeenCalledWith(
      `Skipping deletion of '${fixtures.artifactName}', it does not exist`
    )
  })

  test('passes skipArchive when archive is false', async () => {
    mockInputs({
      [Inputs.Archive]: false
    })

    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [fixtures.filesToUpload[0]],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      [fixtures.filesToUpload[0]],
      fixtures.rootDirectory,
      {compressionLevel: 6, skipArchive: true}
    )
  })

  test('does not pass skipArchive when archive is true', async () => {
    mockInputs({
      [Inputs.Archive]: true
    })

    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [fixtures.filesToUpload[0]],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(artifact.default.uploadArtifact).toHaveBeenCalledWith(
      fixtures.artifactName,
      [fixtures.filesToUpload[0]],
      fixtures.rootDirectory,
      {compressionLevel: 6}
    )
  })

  test('uploads each file under its combined name when archive is false and multiple files are provided', async () => {
    // skipArchive makes the artifact client name the artifact after the file's
    // basename, so the staged file itself must carry the combined name
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ul-test-'))
    const prevWorkspace = process.env['GITHUB_WORKSPACE']
    process.env['GITHUB_WORKSPACE'] = root
    try {
      await fs.mkdir(path.join(root, 'sub'))
      await fs.writeFile(path.join(root, 'file1.txt'), 'one')
      await fs.writeFile(path.join(root, 'sub', 'file2.txt'), 'two')
      mockInputs({[Inputs.Archive]: false})
      mockFindFilesToUpload.mockResolvedValue({
        filesToUpload: [
          path.join(root, 'file1.txt'),
          path.join(root, 'sub', 'file2.txt')
        ],
        rootDirectory: root
      })
      const uploaded: Record<string, string> = {}
      jest
        .spyOn(artifact.default, 'uploadArtifact')
        .mockImplementation(async (name: string, files: string[]) => {
          expect(files).toHaveLength(1)
          expect(path.basename(files[0])).toBe(name)
          uploaded[name] = await fs.readFile(files[0], 'utf8')
          return {size: 1, id: 1, digest: 'd'}
        })

      await run()

      expect(core.setFailed).not.toHaveBeenCalled()
      expect(Object.keys(uploaded)).toEqual([
        'file1.txt',
        'sub_file2.txt',
        '.artifact_upload_manifest.artifact-name.json'
      ])
      expect(uploaded['sub_file2.txt']).toBe('two')
      expect(
        JSON.parse(uploaded['.artifact_upload_manifest.artifact-name.json'])
      ).toEqual({
        version: 1,
        files: [
          {artifact: 'file1.txt', path: 'file1.txt'},
          {artifact: 'sub_file2.txt', path: 'sub/file2.txt'}
        ]
      })
      // The original files are left alone
      expect(await fs.readFile(path.join(root, 'file1.txt'), 'utf8')).toBe(
        'one'
      )
    } finally {
      if (prevWorkspace === undefined) {
        delete process.env['GITHUB_WORKSPACE']
      } else {
        process.env['GITHUB_WORKSPACE'] = prevWorkspace
      }
      await fs.rm(root, {recursive: true, force: true})
    }
  })

  test('fails without uploading when an artifact already exists in the run', async () => {
    mockInputs({
      [Inputs.Archive]: false
    })
    jest.spyOn(artifact.default, 'listArtifacts').mockResolvedValue({
      artifacts: [{name: 'file1.txt'} as any]
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('already exist in this run: file1.txt')
    )
    expect(artifact.default.uploadArtifact).not.toHaveBeenCalled()
  })

  test('fails on files named like an upload manifest', async () => {
    mockInputs({
      [Inputs.Archive]: false
    })
    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [
        '/some/artifact/path/file1.txt',
        '/some/artifact/path/.artifact_upload_manifest.x.json'
      ],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('reserved for upload manifests')
    )
    expect(artifact.default.uploadArtifact).not.toHaveBeenCalled()
  })

  test('fails without uploading when a combined name has an invalid character', async () => {
    mockInputs({
      [Inputs.Archive]: false
    })
    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [
        '/some/artifact/path/file1.txt',
        '/some/artifact/path/logs/10:00.txt'
      ],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('not allowed in artifact names')
    )
    expect(artifact.default.uploadArtifact).not.toHaveBeenCalled()
  })

  test('fails without uploading when combined names collide', async () => {
    mockInputs({
      [Inputs.Archive]: false
    })
    mockFindFilesToUpload.mockResolvedValue({
      filesToUpload: [
        '/some/artifact/path/a_b.txt',
        '/some/artifact/path/a/b.txt'
      ],
      rootDirectory: fixtures.rootDirectory
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("would both be uploaded as 'a_b.txt'")
    )
    expect(artifact.default.uploadArtifact).not.toHaveBeenCalled()
  })
})
