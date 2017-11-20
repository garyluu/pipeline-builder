export default function $http(method, url, data) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.addEventListener('load', () => resolve(xhr.response));
    xhr.addEventListener('error', () => reject);
    xhr.addEventListener('abort', () => reject);
    xhr.open(method, url);

    xhr.responseType = 'text';

    switch (true) {
      case data === undefined:
        return xhr.send();
      case data instanceof ArrayBuffer:
      case data instanceof Blob:
      case typeof data === 'string':
        return xhr.send(data);
      default:
        xhr.setRequestHeader('Content-Type', 'application/json');
        return xhr.send(JSON.stringify(data));
    }
  });
}
