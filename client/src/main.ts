/// <reference path="typings/whatwg-fetch/whatwg-fetch.d.ts" />

type SongID = string
type AlbumID = string

// Fisher-Yates Shuffle
function shuffle<T>(array: T[]): T[] {
    let counter = array.length
    let temp: T
    let index: number

    // While there are elements in the array
    while(counter > 0) {
        // Pick a random index
        index = Math.floor(Math.random() * counter)
        counter -= 1

        // And swap the last element with it
        temp = array[counter]
        array[counter] = array[index]
        array[index] = temp
    }

    return array
}

class Album {
    id: AlbumID
    title: string
    year: string
    tracks: SongID[]
    private coverPath: string
    private cover: Blob

    constructor(id: AlbumID, title: string, year: string, tracks: SongID[], cover: string) {
        this.id = id
        this.title = title
        this.year = year
        this.tracks = tracks

        this.coverPath = cover
        this.cover = null
    }

    getCover(library: MediaLibrary) {
        if(this.cover) {
            return new Promise((resolve, reject) => { resolve(this.cover); })
        }

        return self.fetch(`${library.root}/music/album/${this.id}/cover`).then((response) => {
            if(!response.ok) { return null }
            return response.blob()
        }).then((data: Blob) => {
            this.cover = data
            return data
        })
    }

    static parse(data: {id: string, title: string, year: string, tracks: SongID[], cover: string}) {
        return new Album(data.id, data.title, data.year, data.tracks, data.cover)
    }
}

class Song {
    constructor(public id: SongID, public title: string, public artist: string) {}

    stream() {
        return `/music/song/${this.id}/stream`
    }

    static parse(data: {id: string, title: string, artist: string}) {
        return new Song(data.id, data.title, data.artist)
    }
}

class MediaLibrary {
    root: string
    private songs: SongID[]
    private albums: AlbumID[]

    songCache: Map<SongID, Song>
    albumCache: Map<AlbumID, Album>

    artistIndex: Map<string, SongID[]>
    albumIndex: Map<SongID, AlbumID>

    constructor(root: string) {
        this.root = root

        this.songs = []
        this.albums = []

        this.songCache = new Map<SongID, Song>()
        this.albumCache = new Map<AlbumID, Album>()

        // this.artistIndex = new Map<string, SongID[]>()
        this.albumIndex = new Map<SongID, AlbumID>()
    }

    refresh() {
        const songs: SongID[] = []
        const albums = new Set<SongID>()
        const songCache = new Map<SongID, Song>()

        return self.fetch(`${this.root}/music/songs`).then((response) => {
            return response.json()
        }).then((results: any[]) => {
            for(let rawSong of results) {
                songs.push(rawSong.id)
                albums.add(rawSong.album)
                this.albumIndex.set(rawSong.id, rawSong.album)

                try {
                    songCache.set(rawSong.id, Song.parse(rawSong))
                } catch(err) {
                    console.error(`Error parsing song ${rawSong.id}`)
                    console.error(err)
                }
            }

            this.songs = songs
            this.albums = Array.from(albums.keys())
            this.songCache = songCache
        }).catch((err) => {
            console.error(err)
        })
    }

    shuffle() {
        return this.refresh().then(() => {
            shuffle(this.songs)
            return this.songs
        })
    }

    songUrl(song: Song): string {
        return this.root + song.stream()
    }

    getSong(id: SongID) {
        if(this.songCache.has(id)) {
            return this.songCache.get(id)
        } else {
            return null
        }
    }

    getAlbum(id: AlbumID) {
        if(this.albumCache.has(id)) {
            return new Promise((resolve, reject) => { resolve(this.albumCache.get(id)) })
        }

        return self.fetch(`${this.root}/music/album/${id}/metadata`).then((response) => {
            return response.json()
        }).then((data) => {
            const album = Album.parse(data)
            this.albumCache.set(id, album)
            return album
        })
    }

    getAlbumBySong(id: SongID) {
        return this.getAlbum(this.albumIndex.get(id))
    }
}

class Player {
    playing: Song
    paused: Song

    element: HTMLAudioElement
    library: MediaLibrary
    playlist: Song[]

    onplay: ()=>void

    constructor(element: HTMLAudioElement, library: MediaLibrary) {
        this.playing = null
        this.paused = null

        this.element = element
        this.library = library
        this.playlist = []

        this.element.controls = false
        this.element.onended = () => {
            this.doPlay()
        }
        this.element.onerror = () => {
            const id = this.playing? this.playing.id : 'unknown'
            console.error(`Error playing ${id}`)
            this.doPlay()
        }

        this.onplay = () => {}
    }

    play(songs: Song[]) {
        this.playlist = songs.slice()
        this.doPlay()
    }

    togglePause() {
        if(this.paused) {
            this.element.play()
            this.playing = this.paused
            this.paused = null
            this.onplay()
            return
        }

        this.element.pause()
        this.paused = this.playing
        this.playing = null
        this.onplay()
    }

    skip() {
        this.doPlay()
    }

    doPlay() {
        this.paused = null
        this.playing = null
        if(this.playlist.length === 0) {
            this.onplay()
            return
        }

        const song = this.playlist.pop()
        this.playing = song
        this.element.src = this.library.songUrl(song)
        this.element.play()

        this.onplay()
    }
}

class CoverSwitcher {
    elements: HTMLImageElement[]
    curCover: Blob
    cur: number

    constructor(elements: HTMLImageElement[]) {
        this.elements = elements.slice(0, 2)
        this.curCover = null
        this.cur = 0
    }

    switch(data: Blob) {
        if(data === this.curCover) { return }

        this.curCover = data

        this.currentElement.classList.add('old')
        this.cur = (this.cur + 1) % 2
        this.currentElement.classList.remove('old')

        if(data === null) {
            this.currentElement.src = ''
            return
        }

        this.currentElement.src = URL.createObjectURL(data)
    }

    get currentElement() {
        return this.elements[this.cur]
    }
}

function main() {
    const audioElement = <HTMLAudioElement>document.getElementById('player')

    const playButton = document.getElementById('play-button')
    const skipButton = document.getElementById('skip-button')
    const labelElement = document.getElementById('caption')

    const coverSwitcher = new CoverSwitcher(<HTMLImageElement[]>Array.from(document.getElementsByClassName('cover')))
    const library = new MediaLibrary('/api')
    const player = new Player(audioElement, library)

    player.onplay = () => {
        const song = player.playing || player.paused

        if(song) {
            labelElement.textContent = `${song.artist} - ${song.title}`

            library.getAlbumBySong(song.id).then((album: Album) => {
                return album.getCover(library)
            }).then((cover: Blob) => {
                coverSwitcher.switch(cover)
            })
        } else {
            coverSwitcher.switch(null)
            labelElement.textContent = ''
        }

        if(player.playing) {
            playButton.className = 'fa fa-pause playing'
        } else {
            playButton.className = 'fa fa-play'
        }
    }

    library.shuffle().then((ids) => ids.map((id) => {
        return library.getSong(id)
    })).then((songs) => {
        playButton.addEventListener('click', function() {
            if(player.playing) {
                player.togglePause()
            } else if(player.paused) {
                player.togglePause()
            } else {
                player.play(songs)
            }
        })

        skipButton.addEventListener('click', function() {
            player.skip()
        })
    })
}

window.addEventListener('DOMContentLoaded', function() {
    main()
})
