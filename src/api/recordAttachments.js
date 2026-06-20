// Generic file-attachments helper, backed by a FileMaker container "pics" table
// related to a parent record by a foreign-key field. Configure it once per
// record type (see ccsAttachments.js) and reuse the CRUD + fresh-URL helpers.
import { findInLayout, createRecord, deleteRecord, uploadContainer, containerImageUrl, getRecord, invalidateRecord } from './filemaker';
import { getCurrentEnv } from '../config/fmpEnvironments';

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'];
const extOf = name => (name || '').split('.').pop().toLowerCase();
const isImage = name => IMG_EXT.includes(extOf(name));

// config: { picsLayout, container, fkField, nameField, parentLayout }
//  - picsLayout:  the container table layout (e.g. 'RCD_Pics')
//  - container:   the container field name (e.g. 'image')
//  - fkField:     foreign key linking a pic row to its parent (e.g. 'rcd_id')
//  - nameField:   optional field that stores the file name (e.g. 'File Name')
export function makeAttachments({ picsLayout, container, fkField, nameField }) {
  // Build a card for a just-uploaded file so the grid can show it immediately,
  // without waiting on a re-list. The view link uses a local object URL until a
  // reload swaps in the real FileMaker URL + authoritative timestamp/author.
  const optimisticCard = (recordId, fileOrBlob, name) => ({
    recordId, name, created: '', by: '',
    isImage: isImage(name), hasFile: true, url: URL.createObjectURL(fileOrBlob),
  });

  const rowToCard = r => {
    const fd = r.fieldData;
    const name = (nameField && fd[nameField]) || `Attachment ${r.recordId}`;
    const streaming = fd[container];
    return {
      recordId: r.recordId,
      name,
      created: fd.CreationTimestamp || '',
      by: fd.CreatedBy || '',
      isImage: isImage(name),
      hasFile: !!streaming,
      url: streaming ? containerImageUrl(streaming, { db: getCurrentEnv().db, layout: picsLayout, recordId: r.recordId, field: container }) : null,
    };
  };

  async function list(parentId) {
    if (!parentId) return [];
    const query = [{ [fkField]: String(parentId) }];
    // Prefer newest-first; CreationTimestamp may not be on the layout, so fall
    // back to an unsorted find if the sort field is rejected.
    let res = await findInLayout(picsLayout, query, { sort: [{ fieldName: 'CreationTimestamp', sortOrder: 'descend' }] });
    if (res?.messages?.[0]?.code && res.messages[0].code !== '0' && res.messages[0].code !== '401') {
      res = await findInLayout(picsLayout, query);
    }
    return (res?.response?.data || []).map(rowToCard);
  }

  async function upload(parentId, file, filename) {
    const name = filename || file.name || 'file';
    const fields = { [fkField]: String(parentId) };
    if (nameField) fields[nameField] = name;
    const created = await createRecord(picsLayout, fields);
    const recordId = created?.response?.recordId;
    if (!recordId) throw new Error(created?.messages?.[0]?.message || 'Could not create attachment record');
    const up = await uploadContainer(picsLayout, recordId, container, file, name);
    if (up?.messages?.[0]?.code !== '0') {
      deleteRecord(picsLayout, recordId).catch(() => {}); // roll back the orphan row
      throw new Error(up?.messages?.[0]?.message || 'Upload failed');
    }
    return optimisticCard(recordId, file, name);
  }

  async function remove(recordId) {
    const res = await deleteRecord(picsLayout, recordId);
    if (res?.messages?.[0]?.code !== '0') throw new Error(res?.messages?.[0]?.message || 'Delete failed');
  }

  // FileMaker container streaming URLs expire with the session — re-fetch the
  // record at click time so attachments stay openable/downloadable forever.
  async function freshUrl(recordId) {
    invalidateRecord(picsLayout, recordId);
    const streaming = (await getRecord(picsLayout, recordId))?.response?.data?.[0]?.fieldData?.[container];
    if (!streaming) return null;
    try { const u = new URL(streaming); return u.pathname + u.search; } catch { return streaming; }
  }

  return { list, upload, remove, freshUrl };
}
