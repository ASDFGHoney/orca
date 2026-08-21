import { uploadBuffer } from '../ssh/sftp-upload'
import type { SftpFactory } from './ssh-filesystem-download'
import type { SshRawTransferOptions } from './ssh-filesystem-file-upload'

export async function writeSshFileBase64Chunk(args: {
  createSftp?: SftpFactory
  rawTransfer?: SshRawTransferOptions
  filePath: string
  contentBase64: string
  append: boolean
}): Promise<void> {
  const contents = Buffer.from(args.contentBase64, 'base64')
  if (args.rawTransfer?.writeBuffer) {
    await args.rawTransfer.writeBuffer(args.filePath, contents, {
      append: args.append,
      exclusive: !args.append
    })
    return
  }
  if (!args.createSftp) {
    throw new Error('remote_binary_upload_unavailable')
  }
  const sftp = await args.createSftp()
  try {
    await uploadBuffer(sftp, contents, args.filePath, {
      append: args.append,
      exclusive: !args.append
    })
  } finally {
    sftp.end()
  }
}
