(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/// <reference path="typings/whatwg-fetch/whatwg-fetch.d.ts" />
'use strict';

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _media = require('./media');

var media = _interopRequireWildcard(_media);

var EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP';

var Player = (function () {
    function Player(element, library) {
        var _this = this;

        _classCallCheck(this, Player);

        this.playing = null;
        this.paused = null;
        this.element = element;
        this.library = library;
        this.playlist = [];
        this.element.controls = false;
        this.element.onended = function () {
            _this.doPlay();
        };
        this.element.onerror = function () {
            var id = _this.playing ? _this.playing.id : 'unknown';
            console.error('Error playing ' + id);
            _this.doPlay();
        };
        this.onplay = function () {};
    }

    _createClass(Player, [{
        key: 'play',
        value: function play(songs) {
            this.playlist = songs.reverse();
            this.doPlay();
        }
    }, {
        key: 'togglePause',
        value: function togglePause() {
            if (this.paused) {
                this.element.play();
                this.playing = this.paused;
                this.paused = null;
                this.onplay();
                return;
            }
            this.element.pause();
            this.paused = this.playing;
            this.playing = null;
            this.onplay();
        }
    }, {
        key: 'skip',
        value: function skip() {
            this.doPlay();
        }
    }, {
        key: 'shuffle',
        value: function shuffle() {
            var _this2 = this;

            this.library.shuffle().then(function (ids) {
                return ids.map(function (id) {
                    return _this2.library.getSong(id);
                });
            }).then(function (songs) {
                _this2.play(songs);
            });
        }
    }, {
        key: 'doPlay',
        value: function doPlay() {
            this.paused = null;
            this.playing = null;
            if (this.playlist.length === 0) {
                this.onplay();
                this.element.pause();
                return;
            }
            var song = this.playlist.pop();
            this.playing = song;
            this.element.src = this.library.songUrl(song);
            this.element.play();
            this.onplay();
        }
    }]);

    return Player;
})();

var CoverSwitcher = (function () {
    function CoverSwitcher(elements) {
        _classCallCheck(this, CoverSwitcher);

        this.elements = elements.slice(0, 2);
        this.curCover = null;
        this.cur = 0;
    }

    _createClass(CoverSwitcher, [{
        key: 'switch',
        value: function _switch(data) {
            if (data === this.curCover) {
                return;
            }
            this.curCover = data;
            this.currentElement.classList.add('old');
            this.cur = (this.cur + 1) % 2;
            this.currentElement.classList.remove('old');
            if (data === null) {
                this.currentElement.src = EMPTY_IMAGE;
                return;
            }
            this.currentElement.src = URL.createObjectURL(data);
        }
    }, {
        key: 'currentElement',
        get: function get() {
            return this.elements[this.cur];
        }
    }]);

    return CoverSwitcher;
})();

function main() {
    var audioElement = document.getElementById('player');
    var albumsButton = document.getElementById('albums-button');
    var albumsList = document.getElementById('album-list');
    var playButton = document.getElementById('play-button');
    var skipButton = document.getElementById('skip-button');
    var labelElement = document.getElementById('caption');
    var coverSwitcher = new CoverSwitcher(Array.from(document.getElementsByClassName('cover')));
    var library = new media.MediaLibrary('/api');
    var player = new Player(audioElement, library);
    library.refresh();
    player.onplay = function () {
        var song = player.playing || player.paused;
        if (song) {
            labelElement.textContent = song.artist + ' - ' + song.title;
            library.getAlbumBySong(song.id).then(function (album) {
                return album.getCover(library);
            }).then(function (cover) {
                coverSwitcher['switch'](cover);
            });
        } else {
            coverSwitcher['switch'](null);
            labelElement.textContent = '';
        }
        if (player.playing) {
            playButton.className = 'fa fa-pause playing';
        } else {
            playButton.className = 'fa fa-play';
        }
    };
    playButton.addEventListener('click', function () {
        if (player.playing) {
            player.togglePause();
        } else if (player.paused) {
            player.togglePause();
        } else {
            player.shuffle();
        }
    });
    skipButton.addEventListener('click', function () {
        player.skip();
    });
    var shown = false;
    albumsButton.addEventListener('click', function () {
        if (shown) {
            albumsList.innerHTML = '';
            shown = false;
            return;
        }
        shown = true;
        library.getAlbums().then(function (albums) {
            albums.sort(function (a, b) {
                return a.compare(b);
            });
            albumsList.innerHTML = '';
            // Add the "shuffle" entry
            {
                var el = document.createElement('div');
                el.addEventListener('click', function () {
                    player.shuffle();
                });
                var label = document.createElement('span');
                label.className = 'fa fa-random';
                label.title = 'Shuffle';
                el.appendChild(label);
                albumsList.appendChild(el);
            }
            var _iteratorNormalCompletion = true;
            var _didIteratorError = false;
            var _iteratorError = undefined;

            try {
                var _loop = function () {
                    var album = _step.value;

                    var el = document.createElement('div');
                    el.addEventListener('click', function () {
                        var songs = album.tracks.map(function (id) {
                            return library.getSong(id);
                        });
                        player.play(songs);
                    });
                    album.getCover(library).then(function (blob) {
                        if (blob !== null) {
                            el.innerHTML = '';
                            el.style.backgroundImage = 'url(' + URL.createObjectURL(blob) + ')';
                            el.style.backgroundColor = 'transparent';
                        } else {
                            var artistElement = document.createElement('div');
                            var titleElement = document.createElement('div');
                            artistElement.textContent = album.albumArtist;
                            titleElement.textContent = album.title;
                            el.appendChild(artistElement);
                            el.appendChild(titleElement);
                            el.style.backgroundImage = '';
                        }
                    });
                    albumsList.appendChild(el);
                };

                for (var _iterator = albums[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                    _loop();
                }
            } catch (err) {
                _didIteratorError = true;
                _iteratorError = err;
            } finally {
                try {
                    if (!_iteratorNormalCompletion && _iterator['return']) {
                        _iterator['return']();
                    }
                } finally {
                    if (_didIteratorError) {
                        throw _iteratorError;
                    }
                }
            }
        });
    });
}
window.addEventListener('DOMContentLoaded', function () {
    main();
});

},{"./media":2}],2:[function(require,module,exports){
// Fisher-Yates Shuffle
'use strict';

Object.defineProperty(exports, '__esModule', {
    value: true
});

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _shuffle(array) {
    var counter = array.length;
    var temp = undefined;
    var index = undefined;
    // While there are elements in the array
    while (counter > 0) {
        // Pick a random index
        index = Math.floor(Math.random() * counter);
        counter -= 1;
        // And swap the last element with it
        temp = array[counter];
        array[counter] = array[index];
        array[index] = temp;
    }
    return array;
}

var Album = (function () {
    function Album(id, title, albumArtist, year, tracks, haveCover) {
        _classCallCheck(this, Album);

        this.id = id;
        this.title = title;
        this.albumArtist = albumArtist;
        this.year = year;
        this.tracks = tracks;
        this.haveCover = haveCover;
        this.cover = null;
    }

    _createClass(Album, [{
        key: 'getCover',
        value: function getCover(library) {
            var _this = this;

            if (!this.haveCover) {
                return new Promise(function (resolve, reject) {
                    resolve(null);
                });
            }
            if (this.cover) {
                return new Promise(function (resolve, reject) {
                    resolve(_this.cover);
                });
            }
            return self.fetch(library.root + '/music/album/' + this.id + '/cover').then(function (response) {
                if (!response.ok) {
                    return null;
                }
                return response.blob();
            }).then(function (data) {
                _this.cover = data;
                return data;
            });
        }
    }, {
        key: 'compare',
        value: function compare(other) {
            var thisCompiler = this.albumArtist.toLowerCase().split(/^"|the\W/i).join('');
            var otherCompiler = other.albumArtist.toLowerCase().split(/^"|the\W/i).join('');
            if (thisCompiler > otherCompiler) {
                return 1;
            }
            if (thisCompiler < otherCompiler) {
                return -1;
            }
            // Tie-break using year
            if (this.year > other.year) {
                return 1;
            }
            if (this.year < other.year) {
                return -1;
            }
            return 0;
        }
    }], [{
        key: 'parse',
        value: function parse(data) {
            return new Album(data.id, data.title, data.album_artist, data.year, data.tracks, data.cover);
        }
    }]);

    return Album;
})();

exports.Album = Album;

var Song = (function () {
    function Song(id, title, artist) {
        _classCallCheck(this, Song);

        this.id = id;
        this.title = title;
        this.artist = artist;
    }

    _createClass(Song, [{
        key: 'stream',
        value: function stream() {
            return '/music/song/' + this.id + '/stream';
        }
    }], [{
        key: 'parse',
        value: function parse(data) {
            return new Song(data.id, data.title, data.artist);
        }
    }]);

    return Song;
})();

exports.Song = Song;

var MediaLibrary = (function () {
    function MediaLibrary(root) {
        _classCallCheck(this, MediaLibrary);

        this.root = root;
        this.songs = [];
        this.albums = [];
        this.songCache = new Map();
        this.albumCache = new Map();
        // this.artistIndex = new Map<string, SongID[]>()
        this.albumIndex = new Map();
    }

    _createClass(MediaLibrary, [{
        key: 'refresh',
        value: function refresh() {
            var _this2 = this;

            var songs = [];
            var albums = new Set();
            var songCache = new Map();
            return self.fetch(this.root + '/music/songs').then(function (response) {
                return response.json();
            }).then(function (results) {
                var _iteratorNormalCompletion = true;
                var _didIteratorError = false;
                var _iteratorError = undefined;

                try {
                    for (var _iterator = results[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                        var rawSong = _step.value;

                        songs.push(rawSong.id);
                        albums.add(rawSong.album);
                        _this2.albumIndex.set(rawSong.id, rawSong.album);
                        try {
                            songCache.set(rawSong.id, Song.parse(rawSong));
                        } catch (err) {
                            console.error('Error parsing song ' + rawSong.id);
                            console.error(err);
                        }
                    }
                } catch (err) {
                    _didIteratorError = true;
                    _iteratorError = err;
                } finally {
                    try {
                        if (!_iteratorNormalCompletion && _iterator['return']) {
                            _iterator['return']();
                        }
                    } finally {
                        if (_didIteratorError) {
                            throw _iteratorError;
                        }
                    }
                }

                _this2.songs = songs;
                _this2.albums = Array.from(albums.keys());
                _this2.songCache = songCache;
            })['catch'](function (err) {
                console.error('Invalid response from server', err);
            });
        }
    }, {
        key: 'shuffle',
        value: function shuffle() {
            var _this3 = this;

            return this.refresh().then(function () {
                _shuffle(_this3.songs);
                return _this3.songs;
            });
        }
    }, {
        key: 'songUrl',
        value: function songUrl(song) {
            return this.root + song.stream();
        }
    }, {
        key: 'getSong',
        value: function getSong(id) {
            if (this.songCache.has(id)) {
                return this.songCache.get(id);
            } else {
                return null;
            }
        }
    }, {
        key: 'getAlbums',
        value: function getAlbums() {
            var _this4 = this;

            var albums = [];
            return Promise.all(this.albums.map(function (id) {
                return _this4.getAlbum(id).then(function (album) {
                    albums.push(album);
                })['catch'](function (err) {
                    console.error(err);
                });
            })).then(function () {
                return albums;
            });
        }
    }, {
        key: 'getAlbum',
        value: function getAlbum(id) {
            var _this5 = this;

            if (this.albumCache.has(id)) {
                return new Promise(function (resolve, reject) {
                    resolve(_this5.albumCache.get(id));
                });
            }
            return self.fetch(this.root + '/music/album/' + id + '/metadata').then(function (response) {
                return response.json();
            }).then(function (data) {
                var album = Album.parse(data);
                _this5.albumCache.set(id, album);
                return album;
            });
        }
    }, {
        key: 'getAlbumBySong',
        value: function getAlbumBySong(id) {
            return this.getAlbum(this.albumIndex.get(id));
        }
    }]);

    return MediaLibrary;
})();

exports.MediaLibrary = MediaLibrary;

},{}]},{},[1]);
