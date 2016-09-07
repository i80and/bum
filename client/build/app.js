(function () {
'use strict';

// Fisher-Yates Shuffle
function shuffle(array) {
    var counter = array.length;
    var temp;
    var index;
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
        this.id = id;
        this.title = title;
        this.albumArtist = albumArtist;
        this.year = year;
        this.tracks = tracks;
        this.haveCover = haveCover;
        this.cover = null;
    }
    Album.prototype.getCover = function (library) {
        var _this = this;
        if (!this.haveCover) {
            return new Promise(function (resolve, reject) { resolve(null); });
        }
        if (this.cover) {
            return new Promise(function (resolve, reject) { resolve(_this.cover); });
        }
        return self.fetch(library.root + "/music/album/" + this.id + "/cover").then(function (response) {
            if (!response.ok) {
                return null;
            }
            return response.blob();
        }).then(function (data) {
            _this.cover = data;
            return data;
        });
    };
    Album.prototype.compare = function (other) {
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
    };
    Album.parse = function (data) {
        return new Album(data.id, data.title, data.album_artist, data.year, data.tracks, data.cover);
    };
    return Album;
}());
var Song = (function () {
    function Song(id, title, artist) {
        this.id = id;
        this.title = title;
        this.artist = artist;
    }
    Song.prototype.stream = function () {
        return "/music/song/" + this.id + "/stream";
    };
    Song.parse = function (data) {
        return new Song(data.id, data.title, data.artist);
    };
    return Song;
}());
var MediaLibrary = (function () {
    function MediaLibrary(root) {
        this.root = root;
        this.songs = [];
        this.albums = [];
        this.songCache = new Map();
        this.albumCache = new Map();
        // this.artistIndex = new Map<string, SongID[]>()
        this.albumIndex = new Map();
    }
    MediaLibrary.prototype.refresh = function () {
        var _this = this;
        var songs = [];
        var albums = new Set();
        var songCache = new Map();
        return self.fetch(this.root + "/music/songs").then(function (response) {
            return response.json();
        }).then(function (results) {
            for (var _i = 0, results_1 = results; _i < results_1.length; _i++) {
                var rawSong = results_1[_i];
                songs.push(rawSong.id);
                albums.add(rawSong.album);
                _this.albumIndex.set(rawSong.id, rawSong.album);
                try {
                    songCache.set(rawSong.id, Song.parse(rawSong));
                }
                catch (err) {
                    console.error("Error parsing song " + rawSong.id);
                    console.error(err);
                }
            }
            _this.songs = songs;
            _this.albums = Array.from(albums.keys());
            _this.songCache = songCache;
        }).catch(function (err) {
            console.error('Invalid response from server', err);
        });
    };
    MediaLibrary.prototype.shuffle = function () {
        var _this = this;
        return this.refresh().then(function () {
            shuffle(_this.songs);
            return _this.songs;
        });
    };
    MediaLibrary.prototype.songUrl = function (song) {
        return this.root + song.stream();
    };
    MediaLibrary.prototype.getSong = function (id) {
        if (this.songCache.has(id)) {
            return this.songCache.get(id);
        }
        else {
            return null;
        }
    };
    MediaLibrary.prototype.getAlbums = function () {
        var _this = this;
        var albums = [];
        return Promise.all(this.albums.map(function (id) {
            return _this.getAlbum(id).then(function (album) {
                albums.push(album);
            }).catch(function (err) {
                console.error(err);
            });
        })).then(function () {
            return albums;
        });
    };
    MediaLibrary.prototype.getAlbum = function (id) {
        var _this = this;
        if (this.albumCache.has(id)) {
            return new Promise(function (resolve, reject) { resolve(_this.albumCache.get(id)); });
        }
        return self.fetch(this.root + "/music/album/" + id + "/metadata").then(function (response) {
            return response.json();
        }).then(function (data) {
            var album = Album.parse(data);
            _this.albumCache.set(id, album);
            return album;
        });
    };
    MediaLibrary.prototype.getAlbumBySong = function (id) {
        return this.getAlbum(this.albumIndex.get(id));
    };
    return MediaLibrary;
}());

/// <reference path="typings/whatwg-fetch/whatwg-fetch.d.ts" />
var EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP';
var Player = (function () {
    function Player(library) {
        this.playing = null;
        this.paused = null;
        this.library = library;
        this.playlist = [];
        this.onplay = function () { };
        this._initElement();
    }
    Player.prototype.play = function (songs) {
        this.playlist = songs.reverse();
        this.doPlay();
    };
    Player.prototype.togglePause = function () {
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
    };
    Player.prototype.skip = function () {
        this.doPlay();
    };
    Player.prototype.shuffle = function () {
        var _this = this;
        this.library.shuffle().then(function (ids) { return ids.map(function (id) {
            return _this.library.getSong(id);
        }); }).then(function (songs) {
            _this.play(songs);
        });
    };
    Player.prototype.doPlay = function () {
        this.paused = null;
        this.playing = null;
        if (this.playlist.length === 0) {
            this.onplay();
            // Don't pause an errored stream. This can cause a nasty
            // error loop, where pausing triggers reparsing bad input.
            if (!this.element.error) {
                this.element.pause();
            }
            return;
        }
        var song = this.playlist.pop();
        this.playing = song;
        this.element.src = this.library.songUrl(song);
        this.element.play();
        this.onplay();
    };
    Player.prototype._initElement = function () {
        var _this = this;
        this.element = document.createElement('audio');
        this.element.controls = false;
        this.element.onended = function () {
            _this.doPlay();
        };
        this.element.onerror = function () {
            var id = _this.playing ? _this.playing.id : 'unknown';
            console.error("Error playing " + id);
            _this.doPlay();
        };
    };
    return Player;
}());
var CoverSwitcher = (function () {
    function CoverSwitcher(elements) {
        this.elements = elements.slice(0, 2);
        this.curCover = null;
        this.cur = 0;
    }
    CoverSwitcher.prototype.switch = function (data) {
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
    };
    Object.defineProperty(CoverSwitcher.prototype, "currentElement", {
        get: function () {
            return this.elements[this.cur];
        },
        enumerable: true,
        configurable: true
    });
    return CoverSwitcher;
}());
function main() {
    var albumsButton = document.getElementById('albums-button');
    var albumsList = document.getElementById('album-list');
    var playButton = document.getElementById('play-button');
    var skipButton = document.getElementById('skip-button');
    var labelElement = document.getElementById('caption');
    var coverSwitcher = new CoverSwitcher(Array.from(document.getElementsByClassName('cover')));
    var library = new MediaLibrary('/api');
    var player = new Player(library);
    library.refresh();
    player.onplay = function () {
        var song = player.playing || player.paused;
        if (song) {
            labelElement.textContent = song.artist + " - " + song.title;
            library.getAlbumBySong(song.id).then(function (album) {
                return album.getCover(library);
            }).then(function (cover) {
                coverSwitcher.switch(cover);
            });
        }
        else {
            coverSwitcher.switch(null);
            labelElement.textContent = '';
        }
        if (player.playing) {
            playButton.className = 'fa fa-pause playing';
        }
        else {
            playButton.className = 'fa fa-play';
        }
    };
    playButton.addEventListener('click', function () {
        if (player.playing) {
            player.togglePause();
        }
        else if (player.paused) {
            player.togglePause();
        }
        else {
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
            albums.sort(function (a, b) { return a.compare(b); });
            albumsList.innerHTML = '';
            // Add the "shuffle" entry
            {
                var el = document.createElement('div');
                el.addEventListener('click', function () { player.shuffle(); });
                var label = document.createElement('span');
                label.className = 'fa fa-random';
                label.title = 'Shuffle';
                el.appendChild(label);
                albumsList.appendChild(el);
            }
            var _loop_1 = function(album) {
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
                        el.style.backgroundImage = "url(" + URL.createObjectURL(blob) + ")";
                        el.style.backgroundColor = 'transparent';
                    }
                    else {
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
            for (var _i = 0, albums_1 = albums; _i < albums_1.length; _i++) {
                var album = albums_1[_i];
                _loop_1(album);
            }
        });
    });
}
window.addEventListener('DOMContentLoaded', function () {
    main();
});

}());