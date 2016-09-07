(function () {
'use strict';

function __awaiter(thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator.throw(value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments)).next());
    });
}

function shuffle(array) {
    let counter = array.length;
    let temp;
    let index;
    while (counter > 0) {
        index = Math.floor(Math.random() * counter);
        counter -= 1;
        temp = array[counter];
        array[counter] = array[index];
        array[index] = temp;
    }
    return array;
}
class Album {
    constructor(id, title, albumArtist, year, tracks, haveCover) {
        this.id = id;
        this.title = title;
        this.albumArtist = albumArtist;
        this.year = year;
        this.tracks = tracks;
        this.haveCover = haveCover;
        this.cover = null;
    }
    getCover(library) {
        if (!this.haveCover) {
            return new Promise((resolve, reject) => { resolve(null); });
        }
        if (this.cover) {
            return new Promise((resolve, reject) => { resolve(this.cover); });
        }
        return self.fetch(`${library.root}/music/album/${this.id}/cover`).then((response) => {
            if (!response.ok) {
                return null;
            }
            return response.blob();
        }).then((data) => {
            this.cover = data;
            return data;
        });
    }
    compare(other) {
        const thisCompiler = this.albumArtist.toLowerCase().split(/^"|the\W/i).join('');
        const otherCompiler = other.albumArtist.toLowerCase().split(/^"|the\W/i).join('');
        if (thisCompiler > otherCompiler) {
            return 1;
        }
        if (thisCompiler < otherCompiler) {
            return -1;
        }
        if (this.year > other.year) {
            return 1;
        }
        if (this.year < other.year) {
            return -1;
        }
        return 0;
    }
    static parse(data) {
        return new Album(data.id, data.title, data.album_artist, data.year, data.tracks, data.cover);
    }
}
class Song {
    constructor(id, title, artist) {
        this.id = id;
        this.title = title;
        this.artist = artist;
    }
    stream() {
        return `/music/song/${this.id}/stream`;
    }
    static parse(data) {
        return new Song(data.id, data.title, data.artist);
    }
}
class MediaLibrary {
    constructor(root) {
        this.root = root;
        this.songs = [];
        this.albums = [];
        this.songCache = new Map();
        this.albumCache = new Map();
        this.albumIndex = new Map();
    }
    refresh() {
        const songs = [];
        const albums = new Set();
        const songCache = new Map();
        return self.fetch(`${this.root}/music/songs`).then((response) => {
            return response.json();
        }).then((results) => {
            for (let rawSong of results) {
                songs.push(rawSong.id);
                albums.add(rawSong.album);
                this.albumIndex.set(rawSong.id, rawSong.album);
                try {
                    songCache.set(rawSong.id, Song.parse(rawSong));
                }
                catch (err) {
                    console.error(`Error parsing song ${rawSong.id}`);
                    console.error(err);
                }
            }
            this.songs = songs;
            this.albums = Array.from(albums.keys());
            this.songCache = songCache;
        }).catch((err) => {
            console.error('Invalid response from server', err);
        });
    }
    shuffle() {
        return this.refresh().then(() => {
            shuffle(this.songs);
            return this.songs;
        });
    }
    songUrl(song) {
        return this.root + song.stream();
    }
    getSong(id) {
        if (this.songCache.has(id)) {
            return this.songCache.get(id);
        }
        else {
            return null;
        }
    }
    getAlbums() {
        return __awaiter(this, void 0, Promise, function* () {
            const albums = [];
            const response = yield self.fetch(`${this.root}/music/albums`);
            const data = yield response.json();
            for (let i = 0; i < data.length; i += 1) {
                const album = Album.parse(data[i]);
                this.albumCache.set(album.id, album);
                albums.push(album);
            }
            return albums;
        });
    }
    getAlbum(id) {
        if (this.albumCache.has(id)) {
            return new Promise((resolve, reject) => { resolve(this.albumCache.get(id)); });
        }
        return self.fetch(`${this.root}/music/album/${id}/metadata`).then((response) => {
            return response.json();
        }).then((data) => {
            const album = Album.parse(data);
            this.albumCache.set(id, album);
            return album;
        });
    }
    getAlbumBySong(id) {
        return this.getAlbum(this.albumIndex.get(id));
    }
}

const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP';
class Player {
    constructor(library) {
        this.playing = null;
        this.paused = null;
        this.library = library;
        this.playlist = [];
        this.onplay = () => { };
        this._initElement();
    }
    play(songs) {
        this.playlist = songs.reverse();
        this.doPlay();
    }
    togglePause() {
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
    skip() {
        this.doPlay();
    }
    shuffle() {
        this.library.shuffle().then((ids) => ids.map((id) => {
            return this.library.getSong(id);
        })).then((songs) => {
            this.play(songs);
        });
    }
    doPlay() {
        this.paused = null;
        this.playing = null;
        if (this.playlist.length === 0) {
            this.onplay();
            if (!this.element.error) {
                this.element.pause();
            }
            return;
        }
        const song = this.playlist.pop();
        this.playing = song;
        this.element.src = this.library.songUrl(song);
        this.element.play();
        this.onplay();
    }
    _initElement() {
        this.element = document.createElement('audio');
        this.element.controls = false;
        this.element.onended = () => {
            this.doPlay();
        };
        this.element.onerror = () => {
            const id = this.playing ? this.playing.id : 'unknown';
            console.error(`Error playing ${id}`);
            this.doPlay();
        };
    }
}
class CoverSwitcher {
    constructor(elements) {
        this.elements = elements.slice(0, 2);
        this.curCover = null;
        this.cur = 0;
    }
    switch(data) {
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
    get currentElement() {
        return this.elements[this.cur];
    }
}
function main() {
    const albumsButton = document.getElementById('albums-button');
    const albumsList = document.getElementById('album-list');
    const playButton = document.getElementById('play-button');
    const skipButton = document.getElementById('skip-button');
    const labelElement = document.getElementById('caption');
    const coverSwitcher = new CoverSwitcher(Array.from(document.getElementsByClassName('cover')));
    const library = new MediaLibrary('/api');
    const player = new Player(library);
    library.refresh();
    player.onplay = () => {
        const song = player.playing || player.paused;
        if (song) {
            labelElement.textContent = `${song.artist} - ${song.title}`;
            library.getAlbumBySong(song.id).then((album) => {
                return album.getCover(library);
            }).then((cover) => {
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
    let shown = false;
    albumsButton.addEventListener('click', function () {
        if (shown) {
            albumsList.innerHTML = '';
            shown = false;
            return;
        }
        shown = true;
        library.getAlbums().then((albums) => {
            albums.sort((a, b) => { return a.compare(b); });
            albumsList.innerHTML = '';
            {
                const el = document.createElement('div');
                el.addEventListener('click', () => { player.shuffle(); });
                const label = document.createElement('span');
                label.className = 'fa fa-random';
                label.title = 'Shuffle';
                el.appendChild(label);
                albumsList.appendChild(el);
            }
            for (let album of albums) {
                const el = document.createElement('div');
                const tracks = album.tracks;
                el.addEventListener('click', function () {
                    const songs = tracks.map((id) => {
                        return library.getSong(id);
                    });
                    player.play(songs);
                });
                album.getCover(library).then((blob) => {
                    if (blob !== null) {
                        el.innerHTML = '';
                        el.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
                        el.style.backgroundColor = 'transparent';
                    }
                    else {
                        const artistElement = document.createElement('div');
                        const titleElement = document.createElement('div');
                        artistElement.textContent = album.albumArtist;
                        titleElement.textContent = album.title;
                        el.appendChild(artistElement);
                        el.appendChild(titleElement);
                        el.style.backgroundImage = '';
                    }
                });
                albumsList.appendChild(el);
            }
        });
    });
}
window.addEventListener('DOMContentLoaded', function () {
    main();
});

}());