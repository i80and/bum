// Fisher-Yates Shuffle
function shuffle(array) {
    let counter = array.length;
    let temp;
    let index;
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
class Album {
}
class Song {
    stream() {
        return `/music/song/${this.id}/stream`;
    }
}
class MediaLibrary {
    constructor(root) {
        this.root = root;
        this.songs = new Map();
        this.albums = new Map();
        this.artist_index = new Map();
        this.album_index = new Map();
    }
    shuffle() {
        let groups = [];
        let results = [];
        for (let songs of this.artist_index.values()) {
            groups.push(shuffle(songs.slice()));
        }
        for (let group of groups) {
        }
        return results;
    }
    play(song) {
        return this.root + song.stream();
    }
    getSong(id) {
        return this.songs.get(id);
    }
}
class Player {
    constructor(element, library) {
        this.element = element;
        this.library = library;
        this.playlist = [];
        this.element.controls = false;
        this.element.onended = () => {
            this.doPlay();
        };
    }
    play(songs) {
        this.playlist = songs;
        this.doPlay();
    }
    doPlay() {
        if (!this.playlist) {
            return;
        }
        const song = this.playlist.pop();
        this.element.src = this.library.play(song);
    }
}
function main() {
    const library = new MediaLibrary('//localhost:8080/api');
    const songs = library.shuffle().map((id) => {
        return library.getSong(id);
    });
    const audioElement = document.createElement('audio');
    const player = new Player(audioElement, library);
    const playButton = document.createElement('button');
    playButton.value = 'Play';
    playButton.addEventListener('click', function () {
        player.play(songs);
    });
}
window.addEventListener('DOMContentLoaded', function () {
    main();
});
