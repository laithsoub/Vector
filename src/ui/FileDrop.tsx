// ─── FileDrop ────────────────────────────────────────────────────────────────
// @mantine/dropzone with Vector's copy and states. `accept` takes the short
// names used across the app; pass MIME types directly for anything else.
import React from 'react';
import { Dropzone, type DropzoneProps, type FileRejection } from '@mantine/dropzone';
import { FileUp, FileCheck2, FileX2 } from 'lucide-react';

import { notify } from './notify';
import { extClasses } from './theme';

const MIME: Record<string, string[]> = {
  pdf:   ['application/pdf'],
  excel: [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
  ],
  csv:   ['text/csv'],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  email: ['application/vnd.ms-outlook', 'message/rfc822'],
  word:  ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

export type FileKind = keyof typeof MIME;

export type FileDropProps = Omit<DropzoneProps, 'accept' | 'onDrop' | 'children'> & {
  onDrop: (files: File[]) => void;
  accept?: (FileKind | string)[];
  label?: React.ReactNode;
  hint?: React.ReactNode;
  /** Compact single-line layout for toolbars. */
  inline?: boolean;
};

const icon = { width: 'var(--icon-lg)', height: 'var(--icon-lg)', flexShrink: 0 } as const;

export function FileDrop({
  onDrop, accept, label = 'Drop files here or click to browse', hint, inline, onReject, ...rest
}: FileDropProps) {
  const mimes = accept?.flatMap(a => MIME[a] ?? [a]);
  const handleReject = onReject ?? ((rej: FileRejection[]) => {
    const names = rej.map(r => r.file.name).join(', ');
    notify.error(`Not accepted: ${names}`, { title: 'Wrong file type' });
  });
  return (
    <Dropzone classNames={extClasses.dropzone} onDrop={onDrop} onReject={handleReject} accept={mimes} {...rest}>
      <div style={{
        display: 'flex',
        flexDirection: inline ? 'row' : 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: inline ? 'var(--sp-3)' : 'var(--sp-2)',
        textAlign: inline ? 'start' : 'center',
        pointerEvents: 'none',
      }}>
        <Dropzone.Accept><FileCheck2 strokeWidth={1.5} style={icon} /></Dropzone.Accept>
        <Dropzone.Reject><FileX2 strokeWidth={1.5} style={icon} /></Dropzone.Reject>
        <Dropzone.Idle><FileUp strokeWidth={1.5} style={{ ...icon, color: 'var(--t3)' }} /></Dropzone.Idle>
        <div>
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)', color: 'inherit' }}>
            <Dropzone.Idle>{label}</Dropzone.Idle>
            <Dropzone.Accept>Release to add</Dropzone.Accept>
            <Dropzone.Reject>That file type is not accepted here</Dropzone.Reject>
          </div>
          {hint && <div style={{ marginTop: 'var(--sp-0-5)', fontSize: 'var(--fs-xs)', color: 'var(--t3)' }}>{hint}</div>}
        </div>
      </div>
    </Dropzone>
  );
}
