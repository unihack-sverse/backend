export function sendData(res, data, status = 200) {
  res.status(status).json({ data });
}

export function sendCollection(res, data, meta = {}) {
  res.json({
    data,
    meta: {
      nextCursor: null,
      hasMore: false,
      count: data.length,
      ...meta,
    },
  });
}
