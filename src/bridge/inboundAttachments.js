// HealthAgent stub: bridge file attachment resolution
// resolveAndPrepend is used to prepend file attachments to a message.
// In HealthAgent there are no bridge file attachments, so we return content unchanged.
export const resolveAndPrepend = async (_message, content) => content
export default {}
