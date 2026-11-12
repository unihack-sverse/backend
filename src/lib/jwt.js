import jwt from 'jsonwebtoken';

export function signJwt(payload, secret, expiresInSeconds) {
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: expiresInSeconds });
}

export function verifyJwt(token, secret) {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}
